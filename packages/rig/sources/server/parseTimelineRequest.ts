import type { GetTimelineRequest, TimelineScope } from "../protocol/index.js";

/**
 * Reads a timeline request, or explains what is wrong with it.
 *
 * The scope decides how much of Rig the chart covers, so an unrecognised or
 * half-specified scope is rejected rather than quietly narrowed to something the
 * caller did not ask for.
 */
export function parseTimelineRequest(
    body: unknown,
): { request: GetTimelineRequest } | { error: string } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { error: "The timeline request must be an object." };
    }
    const candidate = body as {
        includeArchived?: unknown;
        scope?: unknown;
        since?: unknown;
    };
    const scope = parseScope(candidate.scope);
    if (scope === undefined) {
        return {
            error: "The timeline scope must name a project, a workspace, or a session.",
        };
    }
    if (candidate.includeArchived !== undefined && typeof candidate.includeArchived !== "boolean") {
        return { error: "Including archived chats must be true or false." };
    }
    if (
        candidate.since !== undefined &&
        (typeof candidate.since !== "number" || !Number.isFinite(candidate.since))
    ) {
        return { error: "The timeline start must be a number of milliseconds." };
    }
    return {
        request: {
            scope,
            ...(candidate.includeArchived === undefined
                ? {}
                : { includeArchived: candidate.includeArchived }),
            ...(candidate.since === undefined ? {} : { since: candidate.since }),
        },
    };
}

function parseScope(value: unknown): TimelineScope | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const scope = value as {
        kind?: unknown;
        projectId?: unknown;
        sessionId?: unknown;
        workspaceId?: unknown;
    };
    if (scope.kind === "project" && typeof scope.projectId === "string") {
        return { kind: "project", projectId: scope.projectId };
    }
    if (
        scope.kind === "workspace" &&
        typeof scope.projectId === "string" &&
        typeof scope.workspaceId === "string"
    ) {
        return { kind: "workspace", projectId: scope.projectId, workspaceId: scope.workspaceId };
    }
    if (scope.kind === "session" && typeof scope.sessionId === "string") {
        return { kind: "session", sessionId: scope.sessionId };
    }
    return undefined;
}
