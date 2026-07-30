import type { SessionStore } from "../session/SessionStore.js";

export type HttpProxySessionResolution =
    | { allowed: true }
    | { allowed: false; message: string; statusCode: number; statusText: string };

export function resolveHttpProxySession(
    sessionId: string,
    store: SessionStore,
): HttpProxySessionResolution {
    const session = store.get(sessionId);
    if (session === undefined) {
        return {
            allowed: false,
            message: "The requested Rig session was not found.",
            statusCode: 404,
            statusText: "Not Found",
        };
    }
    if (session.runsInDocker()) {
        return {
            allowed: false,
            message: "HTTP proxy is unavailable for Docker sessions.",
            statusCode: 403,
            statusText: "Forbidden",
        };
    }
    return { allowed: true };
}
