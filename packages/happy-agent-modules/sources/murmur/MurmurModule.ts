import { MurmurClient, type MurmurStore } from "@slopus/murmur";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { detach, type Context, type RootContext } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { ProfileModule } from "../profile/ProfileModule.js";

import { discardMurmurIdentity, murmurMigrations, readMurmurBinding } from "./MurmurDatabase.js";
import { MurmurService, type MurmurClientFacade } from "./MurmurService.js";
import { SqliteMurmurStore } from "./SqliteMurmurStore.js";
import type {
    MurmurChangedEvent,
    MurmurEventListener,
    MurmurInvitation,
    MurmurOutgoingRequest,
    MurmurSnapshot,
    MurmurUnsubscribe,
} from "./MurmurTypes.js";

interface OpenMurmur {
    readonly service: MurmurService;
    readonly store: SqliteMurmurStore;
}

/**
 * Sharing: one Murmur identity, the people it has accepted, and the requests either side is
 * still waiting on.
 *
 * The module owns no file and no socket. Murmur's cryptographic state is kept in the agent
 * database like everything else this agent knows, next to one row saying which person the
 * identity belongs to, so the two can never disagree about who this installation is.
 *
 * Whether sharing runs at all, and which relay it reaches, are configuration decisions: an
 * identity on a relay is not something an installation should acquire because a caller passed a
 * flag.
 */
export class MurmurModule<Database extends AgentDatabase = AgentDatabase> implements AgentModule<
    never,
    Database
> {
    readonly name = "murmur";
    readonly migrations: readonly AgentModuleMigration<Database>[];
    readonly #config: ConfigModule;
    readonly #listeners = new Set<MurmurEventListener>();
    readonly #profile: ProfileModule;
    #closing = false;
    #lifetime: RootContext | undefined;
    #open: OpenMurmur | undefined;
    #tail: Promise<void> = Promise.resolve();

    constructor(config: ConfigModule, profile: ProfileModule) {
        this.#config = config;
        this.#profile = profile;
        this.migrations = murmurMigrations as readonly AgentModuleMigration<Database>[];
    }

    /** Whether the configuration turned sharing on at all. */
    get enabled(): boolean {
        return this.#config.configuration.values.sharing.enabled;
    }

    /** Whether a client is live right now. */
    get running(): boolean {
        return this.#open !== undefined;
    }

    /**
     * Watch sharing after something about it has changed.
     *
     * A subscriber cannot undo the change it is told about, so a failing one is logged and the
     * others still hear it. Returns the function that ends the subscription.
     */
    onEvent(listener: MurmurEventListener): MurmurUnsubscribe {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Opens sharing, if the configuration enabled it and there is a person to share as.
     *
     * The caller may name the person this installation already knows about, which is what
     * turns the setting on for an installation that had a profile before it had sharing.
     * Sharing on with nobody named is not an error: it is the state between enabling the
     * setting and naming the person, and it resolves the moment `bindProfile` is called.
     */
    async open(ctx: Context, profileId?: string): Promise<void> {
        if (!this.enabled) return;
        await this.#transition(async () => {
            if (this.#closing || this.#open !== undefined) return;
            const bound = await readMurmurBinding(ctx);
            if (bound === undefined && profileId === undefined) return;
            this.#open = await this.#start(ctx, bound === undefined ? profileId : undefined);
        });
    }

    /**
     * Names the person this installation shares as, opening sharing if it was waiting for one.
     *
     * This replaces the onboarding step the legacy daemon had: turning sharing on is a
     * configuration decision, and this is the one remaining runtime choice.
     */
    async bindProfile(ctx: Context, profileId: string): Promise<MurmurSnapshot> {
        this.#requireEnabled();
        return await this.#transition(async () => {
            if (this.#closing) throw new Error("Sharing is closing.");
            const existing = this.#open;
            if (existing !== undefined) {
                await existing.service.bindProfile(ctx, profileId);
                return await existing.service.snapshot(ctx);
            }
            const opened = await this.#start(ctx, profileId);
            try {
                const snapshot = await opened.service.snapshot(ctx);
                this.#open = opened;
                return snapshot;
            } catch (error) {
                await this.#stop(ctx, opened);
                throw error;
            }
        });
    }

    async snapshot(ctx: Context): Promise<MurmurSnapshot> {
        return await this.#requireOpen().service.snapshot(ctx);
    }

    async createInvitation(ctx: Context, signal?: AbortSignal): Promise<MurmurInvitation> {
        return await this.#requireOpen().service.createInvitation(ctx, signal);
    }

    async requestContact(
        ctx: Context,
        invitation: string,
        signal?: AbortSignal,
    ): Promise<MurmurOutgoingRequest> {
        return await this.#requireOpen().service.requestContact(ctx, invitation, signal);
    }

    async acceptContact(ctx: Context, requestId: string): Promise<void> {
        await this.#requireOpen().service.acceptContact(ctx, requestId);
    }

    async rejectContact(ctx: Context, requestId: string): Promise<void> {
        await this.#requireOpen().service.rejectContact(ctx, requestId);
    }

    async removeContact(ctx: Context, identity: string): Promise<void> {
        await this.#requireOpen().service.removeContact(ctx, identity);
    }

    /**
     * Throws away this installation's Murmur identity and starts again as the same person.
     *
     * Every contact is lost, because a contact is a relationship with the discarded identity.
     * The person stays: the binding keeps the profile and forgets only the identity, so the
     * client opened next binds its new identity to them instead of being refused.
     */
    async reset(ctx: Context): Promise<MurmurSnapshot> {
        this.#requireEnabled();
        return await this.#transition(async () => {
            if (this.#closing) throw new Error("Sharing is closing.");
            const binding = await readMurmurBinding(ctx);
            if (binding === undefined) throw new Error("Sharing has no profile to reset.");
            const previous = this.#open;
            this.#open = undefined;
            // Nothing may still be writing keys while they are being thrown away, so a live
            // client stops first. A reset arriving while sharing was never started still
            // discards the identity that is sitting in the database.
            if (previous !== undefined) await this.#stop(ctx, previous);
            await discardMurmurIdentity(ctx);
            const opened = await this.#start(ctx, binding.profileId);
            try {
                const snapshot = await opened.service.snapshot(ctx);
                this.#open = opened;
                return snapshot;
            } catch (error) {
                await this.#stop(ctx, opened);
                throw error;
            }
        });
    }

    async close(ctx: Context): Promise<void> {
        this.#closing = true;
        await this.#transition(async () => {
            const open = this.#open;
            this.#open = undefined;
            if (open !== undefined) await this.#stop(ctx, open);
        });
    }

    /**
     * Opens a client on the relay the configuration names.
     *
     * This is the one seam a test replaces, by subclassing and overriding it: there is no relay
     * to reach from a test, and a client is the only thing here that would need one. Nothing in
     * the product overrides it.
     */
    protected async openClient(_ctx: Context, store: MurmurStore): Promise<MurmurClientFacade> {
        return await MurmurClient.open({
            relay: this.#config.configuration.values.sharing.relayUrl,
            store,
        });
    }

    async #start(ctx: Context, bindProfileId?: string): Promise<OpenMurmur> {
        const lifetime = this.#lifetimeFrom(ctx);
        const store = new SqliteMurmurStore(lifetime);
        let service: MurmurService | undefined;
        try {
            const client = await this.openClient(ctx, store);
            service = new MurmurService({
                client,
                lifetime,
                profile: this.#profile,
                publish: (publishCtx, event) => {
                    this.#publish(publishCtx, event);
                },
            });
            if (bindProfileId === undefined) {
                await service.initializeBinding(ctx);
            } else {
                await service.bindProfile(ctx, bindProfileId);
            }
            service.start(ctx);
            return { service, store };
        } catch (error) {
            try {
                if (service !== undefined) await service.close(ctx);
            } finally {
                await store.close();
            }
            throw error;
        }
    }

    async #stop(ctx: Context, open: OpenMurmur): Promise<void> {
        try {
            await open.service.close(ctx);
        } finally {
            await open.store.close();
        }
    }

    /**
     * The lifetime the relay connection and the store run on.
     *
     * Both outlive every call that touches them, so neither may borrow the context of the request
     * that happened to start it. Detaching drops the caller's lifetime and the database with it,
     * so the database is carried back on: sharing needs it for as long as it is open. It is taken
     * once, from whichever call opens sharing first, and reused for every later one.
     *
     * It stays a root because the store and the relay loop each name their own work off it, and
     * only a root can be named again; deriving from a root keeps the root, which the signature of
     * `withAgentDatabase` does not say.
     */
    #lifetimeFrom(ctx: Context): RootContext {
        if (this.#lifetime !== undefined) return this.#lifetime;
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Sharing was opened without an agent database.");
        }
        this.#lifetime = withAgentDatabase(detach(ctx), database) as RootContext;
        return this.#lifetime;
    }

    #publish(ctx: Context, event: MurmurChangedEvent): void {
        for (const listener of [...this.#listeners]) {
            try {
                listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.warn("A sharing subscriber failed.", {}, error);
            }
        }
    }

    #requireEnabled(): void {
        if (!this.enabled) throw new Error("Sharing is disabled.");
    }

    #requireOpen(): OpenMurmur {
        this.#requireEnabled();
        if (this.#closing) throw new Error("Sharing is closing.");
        const open = this.#open;
        if (open === undefined) throw new Error("Sharing has no profile yet.");
        return open;
    }

    /**
     * One lifecycle change at a time.
     *
     * Opening, resetting and closing all replace the live client, and two of them interleaving
     * would leave a client nobody owns connected to the relay. This orders the transitions
     * only; it guards no durable state, which belongs to the database transaction that writes
     * it.
     */
    #transition<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}
