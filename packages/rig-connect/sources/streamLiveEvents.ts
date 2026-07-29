import type { GlobalEvent } from "./protocol.js";
import { readSseFrames } from "./sseFrames.js";

/** The daemon refused the request; retrying it unchanged cannot help. */
export class LiveStreamRefused extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`The daemon refused the live stream with status ${String(status)}.`);
        this.name = "LiveStreamRefused";
        this.status = status;
    }
}

/** The stream opened, but its wire contract cannot be read by this client. */
export class LiveStreamUnsupportedProtocol extends Error {
    constructor() {
        super("The Rig server protocol is not compatible with this rig-connect build.");
        this.name = "LiveStreamUnsupportedProtocol";
    }
}

/** What the daemon says when the stream opens. */
export interface LiveStreamHello {
    /** The position the stream continues from. */
    cursor: string;
    /** The requested cursor could not be served, so held state is stale. */
    gap: boolean;
    /** Version of the HTTP/SSE contract spoken by the daemon. */
    protocolVersion: number;
    /** The stream continued from the requested cursor. */
    resumed: boolean;
}

export interface LiveStreamOptions {
    endpoint: string;
    signal: AbortSignal;
    token: string;
    /**
     * The stream is open and its position is known.
     *
     * This is where a client loads entities: opening first and loading second
     * means anything that changes during the load still arrives here, carrying a
     * cursor that says whether it is newer than what was loaded.
     */
    /** Return false to close permanently without accepting state from this daemon. */
    onOpen: (hello: LiveStreamHello) => unknown;
    onEvent: (event: GlobalEvent, cursor: string) => void;
    /** Reports that the connection dropped and a retry is coming. */
    onDisconnected: (error: unknown) => void;
    /** First reconnect delay. Doubles up to a cap. */
    retryDelayMs?: number;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Test seam for the reconnect delay. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Reconnect delays, kept short because everything here is local.
 *
 * A daemon on the same machine is either there or restarting, so backing off for
 * seconds only makes the interface feel dead for no benefit.
 */
const INITIAL_RETRY_MS = 25;
const MAXIMUM_RETRY_MS = 1_000;

/**
 * Follows the one live stream until the caller aborts.
 *
 * A drop reconnects from the last cursor actually received. When the daemon can
 * still serve that position the stream simply continues; when it cannot, the
 * hello frame reports a gap and the client re-fetches what it holds. A gap is a
 * recovery path, not an error, so the loop keeps running through it.
 */
export async function streamLiveEvents(options: LiveStreamOptions): Promise<void> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const wait = options.wait ?? defaultWait;
    let cursor: string | undefined;
    let retryDelay = options.retryDelayMs ?? INITIAL_RETRY_MS;

    while (!options.signal.aborted) {
        try {
            const delivered = await readStreamOnce(fetchImpl, cursor, options, (accepted) => {
                cursor = accepted;
            });
            // A stream that ends without throwing is a closed connection, so it
            // reconnects like any other drop. The delay resets only when the
            // connection actually delivered something: an endpoint that accepts
            // the request and then closes immediately would otherwise be retried
            // in a hot loop forever, which is exactly the busy work this library
            // must not do.
            if (delivered) retryDelay = options.retryDelayMs ?? INITIAL_RETRY_MS;
            if (options.signal.aborted) return;
            options.onDisconnected(new Error("The live stream closed."));
        } catch (error) {
            if (options.signal.aborted) return;
            // A refused cursor is answered with a gap rather than a status, so
            // any refusal here would refuse the retry too.
            if (
                error instanceof LiveStreamRefused ||
                error instanceof LiveStreamUnsupportedProtocol
            ) {
                throw error;
            }
            options.onDisconnected(error);
        }
        await wait(retryDelay, options.signal);
        retryDelay = Math.min(MAXIMUM_RETRY_MS, retryDelay * 2);
    }
}

/** Reads one connection, reporting whether it delivered any frame at all. */
async function readStreamOnce(
    fetchImpl: typeof globalThis.fetch,
    after: string | undefined,
    options: LiveStreamOptions,
    onCursor: (cursor: string) => void,
): Promise<boolean> {
    const url = new URL("events/live", endpointBase(options.endpoint));
    if (after !== undefined) url.searchParams.set("after", after);

    const response = await fetchImpl(url, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${options.token}` },
        signal: options.signal,
    });
    if (response.status >= 400) {
        // Drained so the connection can be released rather than left hanging.
        await response.text().catch(() => undefined);
        throw new LiveStreamRefused(response.status);
    }
    if (response.body === null) throw new Error("The live stream carried no body.");

    let delivered = false;
    for await (const frame of readSseFrames(response.body)) {
        delivered = true;
        if (frame.name === "hello") {
            const hello = frame.data as LiveStreamHello;
            // Recorded before the caller is told, so a reload triggered from
            // `onOpen` cannot be followed by a reconnect to a stale position.
            onCursor(hello.cursor);
            if (options.onOpen(hello) === false) throw new LiveStreamUnsupportedProtocol();
            continue;
        }
        const update = frame.data as { cursor: string; event: GlobalEvent };
        options.onEvent(update.event, update.cursor);
        onCursor(update.cursor);
    }
    return delivered;
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
