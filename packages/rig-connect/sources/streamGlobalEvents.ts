import type { GlobalEvent, GlobalStreamHello } from "./protocol.js";
import { readSseFrames } from "./sseFrames.js";
import { SessionStreamRefused } from "./streamSessionEvents.js";

export interface GlobalStreamOptions {
    endpoint: string;
    signal: AbortSignal;
    token: string;
    onHello: (hello: GlobalStreamHello) => void;
    onEvent: (event: GlobalEvent) => void;
    /** Reports that the connection dropped and a retry is coming. */
    onDisconnected: (error: unknown) => void;
    retryDelayMs?: number;
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
 * Follows the group event stream until the caller aborts.
 *
 * Reconnects resume from the last event actually received, so the subscriber
 * sees no gap across a drop. A cursor the daemon has dropped is recovered by
 * attaching fresh, which is the documented recovery path rather than a failure.
 */
export async function streamGlobalEvents(options: GlobalStreamOptions): Promise<void> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const wait = options.wait ?? defaultWait;
    let cursor: string | undefined;
    let retryDelay = options.retryDelayMs ?? INITIAL_RETRY_MS;

    while (!options.signal.aborted) {
        try {
            cursor = await readStreamOnce(fetchImpl, cursor, options);
            retryDelay = options.retryDelayMs ?? INITIAL_RETRY_MS;
            if (options.signal.aborted) return;
            options.onDisconnected(new Error("The group stream closed."));
        } catch (error) {
            if (options.signal.aborted) return;
            if (error instanceof SessionStreamRefused) {
                if (error.status !== CURSOR_NOT_FOUND_STATUS || cursor === undefined) throw error;
                cursor = undefined;
            }
            options.onDisconnected(error);
        }
        await wait(retryDelay, options.signal);
        retryDelay = Math.min(MAXIMUM_RETRY_MS, retryDelay * 2);
    }
}

async function readStreamOnce(
    fetchImpl: typeof globalThis.fetch,
    after: string | undefined,
    options: GlobalStreamOptions,
): Promise<string | undefined> {
    const url = new URL("events/stream", endpointBase(options.endpoint));
    if (after !== undefined) url.searchParams.set("after", after);

    const response = await fetchImpl(url, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${options.token}` },
        signal: options.signal,
    });
    if (response.status >= 400) {
        await response.text().catch(() => undefined);
        throw new SessionStreamRefused(response.status);
    }
    if (response.body === null) throw new Error("The group stream carried no body.");

    let cursor = after;
    for await (const frame of readSseFrames(response.body)) {
        if (frame.name === "hello") {
            const hello = frame.data as GlobalStreamHello;
            options.onHello(hello);
            // The frame's cursor is where the log resumes, so a reconnect picks
            // up exactly where this snapshot ended.
            cursor = hello.cursor;
            continue;
        }
        options.onEvent(frame.data as GlobalEvent);
        // Live events carry no id, and taking one as a cursor would make a
        // reconnect skip the stored events after it.
        if (frame.id !== undefined) cursor = frame.id;
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
