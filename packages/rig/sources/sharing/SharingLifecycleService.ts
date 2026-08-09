import type { TX } from "../persistence/Transaction.js";
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
    query<Result>(operation: (tx: TX) => Promise<Result>): Promise<Result>;
    transaction<Result>(operation: (tx: TX) => Promise<Result>): Promise<Result>;
}

export interface SharingLifecycleServiceOptions {
    database: SharingLifecycleDatabase;
    now?: () => number;
    open: () => Promise<ManagedSharingService>;
    profiles: RigProfileStore;
    resetState: () => Promise<void>;
}

export interface ManagedSharingService extends SharingServiceContract {
    bindProfile(profileId: string): Promise<void>;
    close(): Promise<void>;
    start(): void;
}

export interface SharingLifecycleServiceContract extends SharingServiceContract {
    reset(): Promise<SharingSnapshot>;
}

export class SharingLifecycleService implements SharingLifecycleServiceContract {
    readonly #database: SharingLifecycleDatabase;
    readonly #now: () => number;
    readonly #open: () => Promise<ManagedSharingService>;
    readonly #profiles: RigProfileStore;
    readonly #resetState: () => Promise<void>;
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

    async configured(): Promise<boolean> {
        return (await this.#database.query(async (tx) => querySharingSettings(tx))) !== undefined;
    }

    async enabled(): Promise<boolean> {
        return (
            (await this.#database.query(async (tx) => querySharingSettings(tx)))?.enabled === true
        );
    }

    start(): Promise<void> {
        return this.#transition(async () => {
            if (this.#closing || !(await this.enabled()) || this.#service !== undefined) return;
            if (
                (await this.#database.query(async (tx) => querySharingProfileId(tx))) === undefined
            ) {
                throw new Error("Enabled Sharing is missing its bound human profile.");
            }
            const service = await this.#open();
            try {
                service.start();
                this.#service = service;
            } catch (error) {
                await service.close();
                throw error;
            }
        });
    }

    onboardMurmur(request: OnboardMurmurRequest): Promise<OnboardMurmurResponse> {
        if (this.#closing) return Promise.reject(new Error("Sharing is closing."));
        return this.#transition(() =>
            request.enabled ? this.#enable(request.profileId) : this.#disable(),
        );
    }

    acceptContact(requestId: string): Promise<void> {
        return this.#requireService().acceptContact(requestId);
    }

    createInvitation(signal?: AbortSignal) {
        return this.#requireService().createInvitation(signal);
    }

    createFolderShare(folderId: string, contacts: readonly string[]) {
        return this.#requireService().createFolderShare(folderId, contacts);
    }

    foldersChanged(): void {
        this.#service?.foldersChanged();
    }

    rejectContact(requestId: string): Promise<void> {
        return this.#requireService().rejectContact(requestId);
    }

    removeContact(identity: string): Promise<void> {
        return this.#requireService().removeContact(identity);
    }

    reset(): Promise<SharingSnapshot> {
        if (this.#closing) return Promise.reject(new Error("Sharing is closing."));
        return this.#transition(async () => {
            if (!(await this.enabled())) throw new Error("Sharing is disabled.");
            const profileId = await this.#database.query(querySharingProfileId);
            if (profileId === undefined) {
                throw new Error("Enabled Sharing is missing its bound human profile.");
            }
            const previous = this.#service;
            this.#service = undefined;
            await previous?.close();
            await this.#resetState();

            const service = await this.#open();
            try {
                await service.bindProfile(profileId);
                service.start();
                const snapshot = await service.snapshot();
                this.#service = service;
                return snapshot;
            } catch (error) {
                await service.close();
                throw error;
            }
        });
    }

    requestContact(invitation: string, signal?: AbortSignal) {
        return this.#requireService().requestContact(invitation, signal);
    }

    snapshot() {
        return this.#requireService().snapshot();
    }

    close(): Promise<void> {
        this.#closing = true;
        this.#closePromise ??= this.#transition(async () => {
            const service = this.#service;
            this.#service = undefined;
            await service?.close();
        });
        return this.#closePromise;
    }

    async #enable(profileId: string): Promise<OnboardMurmurResponse> {
        const profile = await this.#profiles.get(profileId);
        if (profile === undefined || !(await this.#profiles.isLocal(profileId))) {
            throw new Error("Murmur requires a profile owned by this Rig.");
        }

        const existing = this.#service;
        if (existing !== undefined) {
            await existing.bindProfile(profileId);
            const snapshot = await existing.snapshot();
            await this.#persistEnabled(true);
            return { enabled: true, profile, publicKey: snapshot.identity };
        }

        const service = await this.#open();
        try {
            await service.bindProfile(profileId);
            service.start();
            const snapshot = await service.snapshot();
            await this.#persistEnabled(true);
            this.#service = service;
            return { enabled: true, profile, publicKey: snapshot.identity };
        } catch (error) {
            await service.close();
            throw error;
        }
    }

    async #disable(): Promise<OnboardMurmurResponse> {
        const service = this.#service;
        this.#service = undefined;
        try {
            await this.#persistEnabled(false);
        } catch (error) {
            this.#service = service;
            throw error;
        }
        await service?.close();
        return { enabled: false };
    }

    async #persistEnabled(enabled: boolean): Promise<void> {
        await this.#database.transaction(async (tx) =>
            sharingSettingsSet(tx, enabled, this.#now()),
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
