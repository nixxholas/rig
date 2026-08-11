import type { Context } from "@steve.kite/stdlib";

import {
    querySharingProfileId,
    querySharingSettings,
    sharingSettingsSet,
} from "../persistence/sharing/index.js";
import type {
    OnboardMurmurRequest,
    OnboardMurmurResponse,
    SharingSnapshot,
} from "../protocol/index.js";
import type { RigProfileStore } from "../profiles/index.js";
import type { SharingServiceContract } from "./SharingService.js";

interface SharingLifecycleDatabase {
    query<Result>(ctx: Context, operation: (ctx: Context) => Promise<Result>): Promise<Result>;
    transaction<Result>(
        ctx: Context,
        operation: (ctx: Context) => Promise<Result>,
    ): Promise<Result>;
}

export interface SharingLifecycleServiceOptions {
    database: SharingLifecycleDatabase;
    now?: () => number;
    open: (ctx: Context) => Promise<ManagedSharingService>;
    profiles: RigProfileStore;
    resetState: (ctx: Context) => Promise<void>;
}

export interface ManagedSharingService extends SharingServiceContract {
    bindProfile(ctx: Context, profileId: string): Promise<void>;
    close(ctx: Context): Promise<void>;
    start(ctx: Context): void;
}

export interface SharingLifecycleServiceContract extends SharingServiceContract {
    reset(ctx: Context): Promise<SharingSnapshot>;
}

export class SharingLifecycleService implements SharingLifecycleServiceContract {
    readonly #database: SharingLifecycleDatabase;
    readonly #now: () => number;
    readonly #open: (ctx: Context) => Promise<ManagedSharingService>;
    readonly #profiles: RigProfileStore;
    readonly #resetState: (ctx: Context) => Promise<void>;
    #closePromise: Promise<void> | undefined;
    #closing = false;
    #service: ManagedSharingService | undefined;
    #tail: Promise<void> = Promise.resolve();

    constructor(options: SharingLifecycleServiceOptions) {
        this.#database = options.database;
        this.#now = options.now ?? Date.now;
        this.#open = options.open;
        this.#profiles = options.profiles;
        this.#resetState = options.resetState;
    }

    async configured(ctx: Context): Promise<boolean> {
        return (
            (await this.#database.query(ctx, async (ctx) => querySharingSettings(ctx))) !==
            undefined
        );
    }

    async enabled(ctx: Context): Promise<boolean> {
        return (
            (await this.#database.query(ctx, async (ctx) => querySharingSettings(ctx)))?.enabled ===
            true
        );
    }

    start(ctx: Context): Promise<void> {
        return this.#transition(async () => {
            if (this.#closing || !(await this.enabled(ctx)) || this.#service !== undefined) return;
            if (
                (await this.#database.query(ctx, async (ctx) => querySharingProfileId(ctx))) ===
                undefined
            ) {
                throw new Error("Enabled Sharing is missing its bound human profile.");
            }
            const service = await this.#open(ctx);
            try {
                service.start(ctx);
                this.#service = service;
            } catch (error) {
                await service.close(ctx);
                throw error;
            }
        });
    }

    onboardMurmur(ctx: Context, request: OnboardMurmurRequest): Promise<OnboardMurmurResponse> {
        if (this.#closing) return Promise.reject(new Error("Sharing is closing."));
        return this.#transition(() =>
            request.enabled ? this.#enable(ctx, request.profileId) : this.#disable(ctx),
        );
    }

    acceptContact(ctx: Context, requestId: string): Promise<void> {
        return this.#requireService().acceptContact(ctx, requestId);
    }

    createInvitation(ctx: Context, signal?: AbortSignal) {
        return this.#requireService().createInvitation(ctx, signal);
    }

    createFolderShare(ctx: Context, folderId: string, contacts: readonly string[]) {
        return this.#requireService().createFolderShare(ctx, folderId, contacts);
    }

    async foldersChanged(ctx: Context): Promise<void> {
        await this.#service?.foldersChanged(ctx);
    }

    rejectContact(ctx: Context, requestId: string): Promise<void> {
        return this.#requireService().rejectContact(ctx, requestId);
    }

    removeContact(ctx: Context, identity: string): Promise<void> {
        return this.#requireService().removeContact(ctx, identity);
    }

    reset(ctx: Context): Promise<SharingSnapshot> {
        if (this.#closing) return Promise.reject(new Error("Sharing is closing."));
        return this.#transition(async () => {
            if (!(await this.enabled(ctx))) throw new Error("Sharing is disabled.");
            const profileId = await this.#database.query(ctx, (ctx) => querySharingProfileId(ctx));
            if (profileId === undefined) {
                throw new Error("Enabled Sharing is missing its bound human profile.");
            }
            const previous = this.#service;
            this.#service = undefined;
            await previous?.close(ctx);
            await this.#resetState(ctx);

            const service = await this.#open(ctx);
            try {
                await service.bindProfile(ctx, profileId);
                service.start(ctx);
                const snapshot = await service.snapshot(ctx);
                this.#service = service;
                return snapshot;
            } catch (error) {
                await service.close(ctx);
                throw error;
            }
        });
    }

    requestContact(ctx: Context, invitation: string, signal?: AbortSignal) {
        return this.#requireService().requestContact(ctx, invitation, signal);
    }

    snapshot(ctx: Context) {
        return this.#requireService().snapshot(ctx);
    }

    close(ctx: Context): Promise<void> {
        this.#closing = true;
        this.#closePromise ??= this.#transition(async () => {
            const service = this.#service;
            this.#service = undefined;
            await service?.close(ctx);
        });
        return this.#closePromise;
    }

    async #enable(ctx: Context, profileId: string): Promise<OnboardMurmurResponse> {
        const profile = await this.#profiles.get(ctx, profileId);
        if (profile === undefined || !(await this.#profiles.isLocal(ctx, profileId))) {
            throw new Error("Murmur requires a profile owned by this Rig.");
        }

        const existing = this.#service;
        if (existing !== undefined) {
            await existing.bindProfile(ctx, profileId);
            const snapshot = await existing.snapshot(ctx);
            await this.#persistEnabled(ctx, true);
            return { enabled: true, profile, publicKey: snapshot.identity };
        }

        const service = await this.#open(ctx);
        try {
            await service.bindProfile(ctx, profileId);
            service.start(ctx);
            const snapshot = await service.snapshot(ctx);
            await this.#persistEnabled(ctx, true);
            this.#service = service;
            return { enabled: true, profile, publicKey: snapshot.identity };
        } catch (error) {
            await service.close(ctx);
            throw error;
        }
    }

    async #disable(ctx: Context): Promise<OnboardMurmurResponse> {
        const service = this.#service;
        this.#service = undefined;
        try {
            await this.#persistEnabled(ctx, false);
        } catch (error) {
            this.#service = service;
            throw error;
        }
        await service?.close(ctx);
        return { enabled: false };
    }

    async #persistEnabled(ctx: Context, enabled: boolean): Promise<void> {
        await this.#database.transaction(ctx, async (ctx) =>
            sharingSettingsSet(ctx, enabled, this.#now()),
        );
    }

    #requireService(): SharingServiceContract {
        if (this.#closing) throw new Error("Sharing is closing.");
        if (this.#service === undefined) throw new Error("Sharing is disabled.");
        return this.#service;
    }

    #transition<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}
