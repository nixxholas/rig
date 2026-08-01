import { ONLINE_PRESENCE_ID } from "./builtInPresences.js";
import type { Presence, PresenceState, SetPresenceRequest } from "./types.js";
import { asyncQueue } from "../concurrency/index.js";

export interface PresenceSelection {
    fallbackPresenceId?: string;
    presenceId: string;
    since: number;
    until?: number;
}

export interface PresenceStoreOptions {
    now?: () => number;
    persist?: (selection: PresenceSelection) => Promise<void>;
    presences: readonly Presence[];
    selection?: PresenceSelection;
}

/**
 * Daemon-wide record of where the user is. The presence list itself is fixed by configuration;
 * only the current selection changes while the daemon runs.
 */
export class PresenceStore {
    readonly #listeners = new Set<(state: PresenceState) => void>();
    readonly #now: () => number;
    readonly #persistenceQueue = asyncQueue();
    readonly #persist: ((selection: PresenceSelection) => Promise<void>) | undefined;
    readonly #presences: readonly Presence[];
    #expiry: ReturnType<typeof setTimeout> | undefined;
    #selection: PresenceSelection;
    #selectionRevision = 0;

    constructor(options: PresenceStoreOptions) {
        this.#now = options.now ?? (() => Date.now());
        this.#persist = options.persist;
        this.#presences =
            options.presences.length > 0
                ? options.presences
                : (() => {
                      throw new Error("Presence requires at least one configured state.");
                  })();
        this.#selection = this.#normalize(
            options.selection ?? { presenceId: this.#defaultPresenceId(), since: this.#now() },
        );
        this.#scheduleExpiry();
    }

    presences(): readonly Presence[] {
        return this.#presences;
    }

    state(): PresenceState {
        this.#applyExpiry(true);
        return this.#currentState();
    }

    #currentState(): PresenceState {
        const selection = this.#selection;
        return {
            ...(selection.until === undefined ? {} : { changesAt: selection.until }),
            ...(selection.fallbackPresenceId === undefined
                ? {}
                : { fallbackPresenceId: selection.fallbackPresenceId }),
            presence: this.#find(selection.presenceId),
            presences: this.#presences,
            since: selection.since,
        };
    }

    async setPresence(request: SetPresenceRequest): Promise<PresenceState> {
        const presence = this.#presences.find((candidate) => candidate.id === request.presenceId);
        if (presence === undefined) {
            throw new Error(`There is no presence called "${request.presenceId}".`);
        }
        if (
            request.fallbackPresenceId !== undefined &&
            !this.#presences.some((candidate) => candidate.id === request.fallbackPresenceId)
        ) {
            throw new Error(`There is no presence called "${request.fallbackPresenceId}".`);
        }
        const now = this.#now();
        if (request.until !== undefined && request.until <= now) {
            throw new Error("A presence must expire in the future.");
        }
        const selection: PresenceSelection = this.#normalize({
            ...(request.fallbackPresenceId === undefined
                ? {}
                : { fallbackPresenceId: request.fallbackPresenceId }),
            presenceId: request.presenceId,
            since: now,
            ...(request.until === undefined ? {} : { until: request.until }),
        });
        const revision = ++this.#selectionRevision;
        return this.#persistenceQueue.runInLock(async () => {
            await this.#persist?.(selection);
            if (revision !== this.#selectionRevision) return this.state();
            this.#selection = selection;
            this.#scheduleExpiry();
            return this.#publish();
        });
    }

    onChange(listener: (state: PresenceState) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    close(): void {
        if (this.#expiry !== undefined) clearTimeout(this.#expiry);
        this.#expiry = undefined;
        this.#listeners.clear();
    }

    #applyExpiry(publishAfterPersistence: boolean): void {
        const selection = this.#selection;
        if (selection.until === undefined || selection.until > this.#now()) return;
        const fallback = {
            presenceId: selection.fallbackPresenceId ?? this.#defaultPresenceId(),
            since: selection.until,
        };
        const revision = ++this.#selectionRevision;
        this.#selection = fallback;
        this.#scheduleExpiry();
        void this.#persistenceQueue
            .runInLock(async () => {
                await this.#persist?.(fallback);
                if (publishAfterPersistence && revision === this.#selectionRevision) {
                    this.#publish();
                }
            })
            .catch(() => {
                // An expiry that cannot be written down still takes effect for this daemon.
                if (publishAfterPersistence && revision === this.#selectionRevision) {
                    this.#publish();
                }
            });
    }

    #defaultPresenceId(): string {
        const online = this.#presences.find((presence) => presence.id === ONLINE_PRESENCE_ID);
        return (online ?? this.#presences[0]!).id;
    }

    #find(presenceId: string): Presence {
        const fallbackId = this.#defaultPresenceId();
        return (
            this.#presences.find((presence) => presence.id === presenceId) ??
            this.#presences.find((presence) => presence.id === fallbackId)!
        );
    }

    #normalize(selection: PresenceSelection): PresenceSelection {
        if (this.#presences.some((presence) => presence.id === selection.presenceId)) {
            return selection;
        }
        return { presenceId: this.#defaultPresenceId(), since: selection.since };
    }

    #publish(): PresenceState {
        this.#applyExpiry(false);
        const state = this.#currentState();
        for (const listener of this.#listeners) listener(state);
        return state;
    }

    #scheduleExpiry(): void {
        if (this.#expiry !== undefined) clearTimeout(this.#expiry);
        this.#expiry = undefined;
        const until = this.#selection.until;
        if (until === undefined) return;
        const timer = setTimeout(
            () => {
                this.#expiry = undefined;
                if (until > this.#now()) {
                    this.#scheduleExpiry();
                    return;
                }
                this.#publish();
            },
            Math.min(2_147_000_000, Math.max(0, until - this.#now())),
        );
        timer.unref?.();
        this.#expiry = timer;
    }
}
