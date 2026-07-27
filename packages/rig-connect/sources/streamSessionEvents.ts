import type { EventId, SessionEvent, SessionStreamHello } from "./protocol.js";
import { readSseFrames } from "./sseFrames.js";

export interface SessionStreamHandlers {
    onHello: (hello: SessionStreamHello) => void;
    onEvent: (event: SessionEvent) => void;
    /** Reports that the connection dropped and a retry is coming. */
    onDisconnected: (error: unknown) => void;
}

export interface SessionStreamOptions extends SessionStreamHandlers {
    endpoint: string;
    sessionId: string;
    signal: AbortSignal;
    token: string;
    /** Milliseconds to wait before reconnecting. Grows up to a cap. */
    retryDelayMs?: number;
    /** How many turns the opening frame carries. Defaults to the daemon's bound. */
    transcriptTurnLimit?: number;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Test seam for the reconnect delay. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The daemon's answer when the requested cursor is no longer in its log. */
const CURSOR_NOT_FOUND_STATUS = 409;
const INITIAL_RETRY_MS = 50;
const MAXIMUM_RETRY_MS = 5_000;

/**
 * Follows one session's event stream until the caller aborts.
 *
 * Reconnects resume from the last event the caller actually received, so the
 * subscriber sees no gap, no duplicate, and no reordering across a drop. The
 * loop ends only on abort or on a response the daemon will not serve.
 */
export async function streamSessionEvents(options: SessionStreamOptions): Promise<void> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const wait = options.wait ?? defaultWait;
    let cursor: EventId | undefined;
    let retryDelay = options.retryDelayMs ?? INITIAL_RETRY_MS;

    while (!options.signal.aborted) {
        try {
            cursor = await readStreamOnce(fetchImpl, cursor, options);
            retryDelay = options.retryDelayMs ?? INITIAL_RETRY_MS;
            if (options.signal.aborted) return;
            // A stream that ends without an error is a closed connection rather
            // than a refusal, so it reconnects like any other drop.
            options.onDisconnected(new Error("The session stream closed."));
        } catch (error) {
            if (options.signal.aborted) return;
            if (error instanceof SessionStreamRefused) {
                // A cursor the daemon has already dropped is the one refusal a
                // retry can fix: attaching fresh returns a whole snapshot. Every
                // other refusal would refuse the retry too.
                if (error.status !== CURSOR_NOT_FOUND_STATUS || cursor === undefined) throw error;
                cursor = undefined;
            }
            options.onDisconnected(error);
        }
        await wait(retryDelay, options.signal);
        retryDelay = Math.min(MAXIMUM_RETRY_MS, retryDelay * 2);
    }
}

/** The daemon refused the request; retrying it unchanged cannot help. */
export class SessionStreamRefused extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`The daemon refused the session stream with status ${status}.`);
        this.name = "SessionStreamRefused";
        this.status = status;
    }
}

async function readStreamOnce(
    fetchImpl: typeof globalThis.fetch,
    after: EventId | undefined,
    options: SessionStreamOptions,
): Promise<EventId | undefined> {
    const url = new URL(
        `sessions/${encodeURIComponent(options.sessionId)}/stream`,
        endpointBase(options.endpoint),
    );
    if (after !== undefined) url.searchParams.set("after", after);
    if (options.transcriptTurnLimit !== undefined) {
        url.searchParams.set("turns", String(options.transcriptTurnLimit));
    }

    const response = await fetchImpl(url, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${options.token}` },
        signal: options.signal,
    });
    if (response.status >= 400) {
        // The body is drained so the connection can be reused or released.
        await response.text().catch(() => undefined);
        throw new SessionStreamRefused(response.status);
    }
    if (response.body === null) throw new Error("The session stream carried no body.");

    let cursor = after;
    for await (const frame of readSseFrames(response.body)) {
        if (frame.name === "hello") {
            // The opening frame is current state, not a logged event, so it
            // never becomes the cursor a reconnect resumes from.
            options.onHello(frame.data as SessionStreamHello);
            continue;
        }
        const event = frame.data as SessionEvent;
        options.onEvent(event);
        cursor = event.id;
    }
    return cursor;
}

function endpointBase(endpoint: string): string {
    return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(finish, ms);
        function finish(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
    });
}
