import { ChatStore } from "./ChatStore.js";
import { streamSessionEvents } from "./streamSessionEvents.js";
import type { ChatDelta, ChatElement, SessionState } from "./ChatElement.js";
import type { SessionTranscriptWindow } from "./protocol.js";

export interface ConnectSessionOptions {
    /** Base URL of a Rig endpoint serving the protocol over HTTP. */
    endpoint: string;
    sessionId: string;
    /** Bearer token for the endpoint. Obtaining it is the caller's job. */
    token: string;
    /** Receives the current list whenever any element changes. */
    onChange: (elements: readonly ChatElement[], session: SessionState) => void;
    /** Receives ordered local-state deltas. Never called before `onChange`. */
    onDelta?: (delta: ChatDelta) => void;
    /** Reports a failure that ended the connection for good. */
    onError?: (error: unknown) => void;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** How many turns the opening frame carries. Defaults to the daemon's bound. */
    transcriptTurnLimit?: number;
}

export interface SessionConnection {
    /** The current element list. Same array identity until something changes. */
    elements: () => readonly ChatElement[];
    session: () => SessionState;
    /**
     * Adds the turns before the oldest one loaded to the front of the list.
     *
     * Loading is the one thing a caller waits on, so this is the only part of
     * the surface that returns a promise. It resolves once the list reflects the
     * outcome, whether that is more history, the beginning of the conversation,
     * or a failure reported on the session state. Concurrent calls share one
     * request, and a call that is still in flight when the connection closes
     * resolves without touching the list.
     */
    loadEarlier: () => Promise<void>;
    /** Releases every resource held by this connection. */
    close: () => void;
}

/**
 * Subscribes to the live state of one session.
 *
 * This is the whole surface of the library. It opens one stream, keeps the chat
 * state current from it, and hands the caller an ordered element list plus a
 * stream of deltas. It never issues a follow-up request to interpret something
 * it was just told.
 */
export function connectSession(options: ConnectSessionOptions): SessionConnection {
    const store = new ChatStore(options.sessionId);
    const controller = new AbortController();
    let closed = false;

    const publish = (deltas: readonly ChatDelta[]): void => {
        if (closed || deltas.length === 0) return;
        // The list is handed over before the deltas, so a consumer reacting to a
        // delta always reads state that already reflects it.
        options.onChange(store.elements(), store.session());
        for (const delta of deltas) options.onDelta?.(delta);
    };

    publish(store.setConnection("connecting"));

    void streamSessionEvents({
        endpoint: options.endpoint,
        sessionId: options.sessionId,
        signal: controller.signal,
        token: options.token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.transcriptTurnLimit === undefined
            ? {}
            : { transcriptTurnLimit: options.transcriptTurnLimit }),
        onHello: (hello) => {
            const deltas = store.applyHello(hello);
            publish([...store.setConnection("live"), ...deltas]);
        },
        onEvent: (event) => publish(store.apply(event)),
        onDisconnected: () => publish(store.setConnection("reconnecting")),
    })
        .catch((error: unknown) => {
            if (closed) return;
            publish(store.setConnection("closed"));
            options.onError?.(error);
        })
        .finally(() => {
            if (!closed) publish(store.setConnection("closed"));
        });

    let loading: Promise<void> | undefined;

    const loadEarlier = async (): Promise<void> => {
        const anchor = store.earlierTranscriptAnchor();
        if (closed || anchor === undefined) return;
        // Concurrent callers share one request. A virtual list can ask again
        // while a page is still arriving, and two requests from the same anchor
        // would fetch the same turns twice.
        loading ??= (async () => {
            try {
                publish(store.startLoadingEarlier());
                const page = await fetchEarlier(options, anchor.before, controller.signal);
                if (closed) return;
                publish(store.prependEarlier(page, anchor));
            } catch (error: unknown) {
                if (closed) return;
                publish(store.failLoadingEarlier(describeLoadFailure(error)));
            } finally {
                loading = undefined;
            }
        })();
        await loading;
    };

    return {
        elements: () => store.elements(),
        loadEarlier,
        session: () => store.session(),
        close: () => {
            if (closed) return;
            closed = true;
            controller.abort();
        },
    };
}

/** Fetches the whole turns immediately before `before`. */
async function fetchEarlier(
    options: ConnectSessionOptions,
    before: string,
    signal: AbortSignal,
): Promise<SessionTranscriptWindow> {
    const request = options.fetch ?? globalThis.fetch;
    const url = `${options.endpoint}/sessions/${encodeURIComponent(options.sessionId)}/transcript?before=${encodeURIComponent(before)}`;
    const response = await request(url, {
        headers: { authorization: `Bearer ${options.token}` },
        signal,
    });
    if (!response.ok) {
        throw new Error(
            response.status === 409
                ? "That part of the conversation is no longer available."
                : `Rig answered with ${String(response.status)}.`,
        );
    }
    return (await response.json()) as SessionTranscriptWindow;
}

function describeLoadFailure(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) return error.message;
    return "Earlier messages could not be loaded.";
}
