import { MurmurClient, type MurmurStore } from "@slopus/murmur";
import type { AgentDatabase, AgentModule, AgentModuleMigration } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context, RootContext } from "@steve.kite/stdlib";

import type { ProfileModule } from "../profile/ProfileModule.js";

import { discardMurmurIdentity, murmurMigrations, readMurmurBinding } from "./MurmurDatabase.js";
import { MurmurService, type MurmurClientFacade } from "./MurmurService.js";
import { SqliteMurmurStore } from "./SqliteMurmurStore.js";
import {
    murmurModuleListenerSchema,
    type MurmurInvitation,
    type MurmurOutgoingRequest,
    type MurmurSnapshot,
} from "./MurmurTypes.js";

export const DEFAULT_MURMUR_RELAY_URL = "https://murmur.cluster-fluster.com/";

const exact = { additionalProperties: false } as const;
// Whole objects this module is handed rather than told about: a live catalog, a lifetime, a
// client. Their shape is their own, so the schema stands for the type without describing it.
const opaque = { additionalProperties: true } as const;
const murmurContextSchema = Type.Unsafe<Context>(Type.Object({}, opaque));
const murmurRootContextSchema = Type.Unsafe<RootContext>(Type.Object({}, opaque));
const murmurProfileModuleSchema = Type.Unsafe<ProfileModule>(Type.Object({}, opaque));
const murmurStoreSchema = Type.Unsafe<MurmurStore>(Type.Object({}, opaque));
const murmurClientFacadeSchema = Type.Unsafe<MurmurClientFacade>(Type.Object({}, opaque));

export const murmurModuleOptionsSchema = Type.Object(
    {
        /** Off unless the configuration turns it on. Nothing connects to a relay by default. */
        enabled: Type.Boolean(),
        listener: Type.Optional(murmurModuleListenerSchema),
        now: Type.Optional(Type.Function([], Type.Integer({ minimum: 0 }))),
        onError: Type.Optional(
            Type.Function([Type.Unknown()], Type.Union([Type.Void(), Type.Promise(Type.Void())])),
        ),
        /** Opens a fresh Murmur client over the store this module opened. */
        openClient: Type.Optional(
            Type.Function(
                [murmurContextSchema, murmurStoreSchema],
                Type.Promise(murmurClientFacadeSchema),
            ),
        ),
        /**
         * The catalog holding the one person this installation shares as.
         *
         * Sharing puts a person on the wire so a contact sees a name rather than a key, and it is
         * that catalog which decides whether this installation may act as them at all.
         */
        profile: murmurProfileModuleSchema,
        relay: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
        /**
         * The lifetime the relay connection and the store run on, with the agent database attached.
         *
         * Both outlive every call that touches them, so neither may borrow the context of the
         * request that happened to start it.
         */
        rootContext: murmurRootContextSchema,
    },
    exact,
);
export type MurmurModuleOptions = Static<typeof murmurModuleOptionsSchema>;

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
 */
export class MurmurModule<Database extends AgentDatabase = AgentDatabase>
    implements AgentModule<never, Database>
{
    readonly name = "murmur";
    readonly migrations: readonly AgentModuleMigration<Database>[];
    readonly #options: MurmurModuleOptions;
    #closing = false;
    #open: OpenMurmur | undefined;
    #tail: Promise<void> = Promise.resolve();

    constructor(options: MurmurModuleOptions) {
        if (!Value.Check(murmurModuleOptionsSchema, options)) {
            throw new Error("Murmur module options are invalid.");
        }
        this.#options = options;
        this.migrations = murmurMigrations as readonly AgentModuleMigration<Database>[];
    }

    /** Whether the configuration turned sharing on at all. */
    get enabled(): boolean {
        return this.#options.enabled;
    }

    /** Whether a client is live right now. */
    get running(): boolean {
        return this.#open !== undefined;
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
        if (!this.#options.enabled) return;
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

    async #start(ctx: Context, bindProfileId?: string): Promise<OpenMurmur> {
        const store = new SqliteMurmurStore(this.#options.rootContext);
        let service: MurmurService | undefined;
        try {
            const client = await this.#openClient(ctx, store);
            const listener = this.#options.listener;
            service = new MurmurService({
                client,
                ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
                ...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
                profile: this.#options.profile,
                publish: (publishCtx, event) => {
                    void listener?.onEvent?.(publishCtx, event);
                },
                rootContext: this.#options.rootContext,
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

    async #openClient(ctx: Context, store: MurmurStore): Promise<MurmurClientFacade> {
        if (this.#options.openClient !== undefined) {
            return await this.#options.openClient(ctx, store);
        }
        return await MurmurClient.open({
            relay: this.#options.relay ?? DEFAULT_MURMUR_RELAY_URL,
            store,
        });
    }

    #requireEnabled(): void {
        if (!this.#options.enabled) throw new Error("Sharing is disabled.");
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
