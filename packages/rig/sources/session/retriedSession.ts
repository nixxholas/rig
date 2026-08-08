import type { CreateSessionRequest } from "../protocol/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";

/**
 * Answers a create whose identity already names a session.
 *
 * The identity is the client's, so repeating it means the same session and the
 * request is simply answered again. An identity that names a session somewhere
 * else is a different session wearing this one's name, and that is an error
 * rather than something to reconcile.
 */
export function retriedSession(
    existing: InMemorySession,
    request: CreateSessionRequest,
): InMemorySession {
    const snapshot = existing.snapshot();
    if (request.scope !== undefined) {
        const sameScope =
            request.scope.kind === "unsorted"
                ? snapshot.scope.kind === "unsorted"
                : snapshot.scope.kind === "folder" &&
                  snapshot.scope.folderId === request.scope.folderId;
        if (!sameScope) {
            throw new Error("That session ID already names a session in another location.");
        }
        return existing;
    }
    if (normalizeProjectCwd(snapshot.cwd) !== normalizeProjectCwd(request.cwd)) {
        throw new Error("That session ID already names a session in another directory.");
    }
    if (request.workspaceId !== undefined && snapshot.workspaceId !== request.workspaceId) {
        throw new Error("That session ID already names a session in another workspace.");
    }
    return existing;
}
