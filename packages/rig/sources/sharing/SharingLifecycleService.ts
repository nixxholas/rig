import type { TX } from "../persistence/Transaction.js";
import {
    querySharingProfileId,
    querySharingSettings,
    sharingSettingsSet,
} from "../persistence/sharing/index.js";
import type { OnboardMurmurRequest, OnboardMurmurResponse } from "../protocol/index.js";
import type { RigProfileStore } from "../profiles/index.js";
import type { SharingServiceContract } from "./SharingService.js";

interface SharingLifecycleDatabase {
    query<Result>(operation: (tx: TX) => Result): Result;
    transaction<Result>(operation: (tx: TX) => Result): Result;
}

export interface SharingLifecycleServiceOptions {
    database: SharingLifecycleDatabase;
    now?: () => number;
    open: () => Promise<ManagedSharingService>;
    profiles: RigProfileStore;
}

export interface ManagedSharingService extends SharingServiceContract {
    bindProfile(profileId: string): void;
    close(): Promise<void>;
    start(): void;
}

export class SharingLifecycleService implements SharingServiceContract {
    readonly #database: SharingLifecycleDatabase;
    readonly #now: () => number;
    readonly #open: () => Promise<ManagedSharingService>;
    readonly #profiles: RigProfileStore;
    #closePromise: Promise<void> | undefined;
    #closing = false;
    #service: ManagedSharingService | undefined;
    #tail: Promise<void> = Promise.resolve();

    constructor(options: SharingLifecycleServiceOptions) {
        this.#database = options.database;
        this.#now = options.now ?? Date.now;
        this.#open = options.open;
        this.#profiles = options.profiles;
    }

    configured(): boolean {
        return this.#database.query(querySharingSettings) !== undefined;
    }

    enabled(): boolean {
        return this.#database.query(querySharingSettings)?.enabled === true;
    }

    start(): Promise<void> {
        return this.#transition(async () => {
            if (this.#closing || !this.enabled() || this.#service !== undefined) return;
            if (this.#database.query(querySharingProfileId) === undefined) {
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
        const profile = this.#profiles.get(profileId);
        if (profile === undefined || !this.#profiles.isLocal(profileId)) {
            throw new Error("Murmur requires a profile owned by this Rig.");
        }

        const existing = this.#service;
        if (existing !== undefined) {
            existing.bindProfile(profileId);
            const snapshot = await existing.snapshot();
            this.#persistEnabled(true);
            return { enabled: true, profile, publicKey: snapshot.identity };
        }

        const service = await this.#open();
        try {
            service.bindProfile(profileId);
            service.start();
            const snapshot = await service.snapshot();
            this.#persistEnabled(true);
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
            this.#persistEnabled(false);
        } catch (error) {
            this.#service = service;
            throw error;
        }
        await service?.close();
        return { enabled: false };
    }

    #persistEnabled(enabled: boolean): void {
        this.#database.transaction((tx) => sharingSettingsSet(tx, enabled, this.#now()));
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
