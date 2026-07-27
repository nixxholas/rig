import { ChatStore } from "./ChatStore.js";
import { streamSessionEvents } from "./streamSessionEvents.js";
import type { ChatDelta, ChatElement, SessionState } from "./ChatElement.js";

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
}

export interface SessionConnection {
    /** The current element list. Same array identity until something changes. */
    elements: () => readonly ChatElement[];
    session: () => SessionState;
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

    return {
        elements: () => store.elements(),
        session: () => store.session(),
        close: () => {
            if (closed) return;
            closed = true;
            controller.abort();
        },
    };
}
