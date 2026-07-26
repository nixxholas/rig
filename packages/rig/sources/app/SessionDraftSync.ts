/**
 * Mirrors the composer draft between this terminal and every other client
 * attached to the same session.
 *
 * Keystrokes are coalesced so typing produces one write per pause rather than
 * one per character, and the writer's own echo is recognised by origin so an
 * update never bounces back into the editor the user is typing in.
 */
export interface SessionDraftSyncOptions {
    /** Identifies this client in the drafts it writes. */
    origin: string;
    /** Sends the draft to the daemon. Rejections are reported, never thrown. */
    push: (draft: string) => Promise<void>;
    /** Milliseconds of quiet typing before a draft is written. */
    debounceMs?: number;
    onError?: (error: unknown) => void;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
}

const DEFAULT_DEBOUNCE_MS = 250;

export class SessionDraftSync {
    #clearTimer: (timer: NodeJS.Timeout) => void;
    #debounceMs: number;
    #disposed = false;
    #inFlight: Promise<void> | undefined;
    #onError: ((error: unknown) => void) | undefined;
    #origin: string;
    #pending: string | undefined;
    #push: (draft: string) => Promise<void>;
    #remote: string;
    #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    #timer: NodeJS.Timeout | undefined;

    constructor(options: SessionDraftSyncOptions & { draft?: string }) {
        this.#origin = options.origin;
        this.#push = options.push;
        this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.#onError = options.onError;
        this.#remote = options.draft ?? "";
        this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.#clearTimer =
            options.clearTimer ??
            ((timer) => {
                clearTimeout(timer);
            });
    }

    /** The draft this client believes the daemon currently holds. */
    get remote(): string {
        return this.#remote;
    }

    /** Records the composer's current text and schedules a write if it changed. */
    recordLocalText(text: string): void {
        if (this.#disposed) return;
        if (text === this.#remote) {
            this.#cancelTimer();
            this.#pending = undefined;
            return;
        }
        this.#pending = text;
        this.#cancelTimer();
        this.#timer = this.#setTimer(() => {
            this.#timer = undefined;
            void this.#write();
        }, this.#debounceMs);
    }

    /**
     * Applies a draft another client wrote. Returns the text the composer should
     * show, or `undefined` when this client's own text should stand: either the
     * update is our echo, or we hold a newer local edit that is about to win.
     */
    applyRemoteDraft(draft: string, origin?: string): string | undefined {
        this.#remote = draft;
        if (this.#disposed) return undefined;
        if (origin === this.#origin) return undefined;
        if (this.#pending !== undefined) return undefined;
        return draft;
    }

    /** Writes any pending draft immediately and waits for it to land. */
    async flush(): Promise<void> {
        this.#cancelTimer();
        await this.#write();
        await this.#inFlight;
    }

    /**
     * Stops syncing. Later composer changes, including the teardown that clears
     * the editor, no longer touch the stored draft.
     */
    dispose(): void {
        this.#disposed = true;
        this.#cancelTimer();
        this.#pending = undefined;
    }

    #cancelTimer(): void {
        if (this.#timer === undefined) return;
        this.#clearTimer(this.#timer);
        this.#timer = undefined;
    }

    async #write(): Promise<void> {
        const draft = this.#pending;
        if (draft === undefined) return;
        this.#pending = undefined;
        if (draft === this.#remote) return;
        // Assume the write lands so the echo of our own draft is recognised.
        // A failed write leaves the daemon on the previous draft; the next
        // keystroke re-sends, and this client keeps showing the user's text.
        this.#remote = draft;
        const previous = this.#inFlight;
        const write = (async () => {
            // Writes stay ordered so a slow request cannot overwrite a newer draft.
            if (previous !== undefined) await previous;
            try {
                await this.#push(draft);
            } catch (error) {
                this.#onError?.(error);
            }
        })();
        this.#inFlight = write;
        await write;
        if (this.#inFlight === write) this.#inFlight = undefined;
    }
}
