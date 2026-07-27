import { connectRig, type RigSessionConnection } from "./connectRig.js";
import type { ChatDelta, ChatElement, SessionState } from "./ChatElement.js";

export interface ConnectSessionOptions {
    endpoint: string;
    sessionId: string;
    token: string;
    onChange: (elements: readonly ChatElement[], session: SessionState) => void;
    onDelta?: (delta: ChatDelta) => void;
    onError?: (error: unknown) => void;
    fetch?: typeof globalThis.fetch;
    transcriptTurnLimit?: number;
}

export type SessionConnection = RigSessionConnection;

/**
 * Compatibility subscription for callers that need only one session.
 *
 * Applications with more than one view should create one `connectRig` client
 * and share it; this wrapper owns and closes that client with its subscription.
 */
export function connectSession(options: ConnectSessionOptions): SessionConnection {
    const rig = connectRig({
        endpoint: options.endpoint,
        token: options.token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const subscription = rig.connectSession({
        onChange: options.onChange,
        sessionId: options.sessionId,
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
        ...(options.transcriptTurnLimit === undefined
            ? {}
            : { transcriptTurnLimit: options.transcriptTurnLimit }),
    });
    return {
        elements: subscription.elements,
        loadMore: subscription.loadMore,
        session: subscription.session,
        close: () => {
            subscription.close();
            rig.close();
        },
    };
}