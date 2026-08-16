import type { AgentEvent } from "@slopus/happy-agent-modules";
import { describe, expect, it } from "vitest";

import { initialEventWindow, projectSessionEvent } from "../sources/modules/http/sessionRoutes.js";

const SESSION_ID = "session-1";

function permissionEvent(payload: Record<string, unknown>, id = "event-1"): AgentEvent {
    return {
        agentId: "agent-1",
        id,
        occurredAt: 1_000,
        payload,
        type: "permission.event",
    };
}

describe("projectSessionEvent for permission events", () => {
    it("projects reviewed and denied actions to a dedicated permission-review event", () => {
        const reviewed = projectSessionEvent(
            permissionEvent({
                type: "permission_action_reviewed",
                agentId: "agent-1",
                callId: "call-1",
                tool: "publish",
                action: "Publish to /tmp/out, outside the workspace.",
                elevated: true,
                reason: "The user asked for exactly this.",
                risk: "medium",
                userAuthorization: "high",
                transcript: {
                    entries: [{ type: "text", text: "Looks fine." }],
                    modelId: "codex-auto-review",
                    providerId: "codex",
                    usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8 },
                },
            }),
            SESSION_ID,
        );

        expect(reviewed).toMatchObject({
            id: "event-1",
            sessionId: SESSION_ID,
            type: "permission_review",
            data: {
                event: {
                    type: "permission_review",
                    action: "Publish to /tmp/out, outside the workspace.",
                    decision: "allow",
                    reason: "The user asked for exactly this.",
                    risk: "medium",
                    toolCallId: "call-1",
                    userAuthorization: "high",
                    transcript: {
                        entries: [{ type: "text", text: "Looks fine." }],
                        modelId: "codex-auto-review",
                        providerId: "codex",
                        usage: {
                            input: 5,
                            output: 3,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 8,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        },
                    },
                },
            },
        });

        const denied = projectSessionEvent(
            permissionEvent({
                type: "permission_action_denied",
                agentId: "agent-1",
                callId: "call-2",
                tool: "publish",
                action: "Publish to /etc/hosts, outside the workspace.",
                reason: "The file belongs to the system.",
                risk: "high",
                userAuthorization: "low",
            }),
            SESSION_ID,
        );

        expect(denied).toMatchObject({
            type: "permission_review",
            data: {
                event: {
                    type: "permission_review",
                    decision: "deny",
                    reason: "The file belongs to the system.",
                    risk: "high",
                    toolCallId: "call-2",
                    userAuthorization: "low",
                },
            },
        });
    });

    it("projects an unproven action to an English system notice", () => {
        const timedOut = projectSessionEvent(
            permissionEvent({
                type: "permission_action_unproven",
                agentId: "agent-1",
                callId: "call-1",
                tool: "publish",
                action: "Publish to /tmp/out, outside the workspace.",
                kind: "timed_out",
                reason: "The reviewer did not answer within 90 seconds.",
            }),
            SESSION_ID,
        );

        expect(timedOut).toEqual({
            createdAt: 1_000,
            id: "event-1",
            sessionId: SESSION_ID,
            worktreeSupport: "unknown",
            type: "system_notice",
            data: {
                message: {
                    role: "system",
                    id: "event-1",
                    context: "excluded",
                    blocks: [
                        {
                            type: "text",
                            text: "The action was not performed because its automatic permission review did not finish in time. No judgment was made that the action was unsafe.",
                        },
                    ],
                    structured: {
                        kind: "notice",
                        title: "Automatic permission review did not finish",
                        details:
                            "The action was not performed because its automatic permission review did not finish in time. No judgment was made that the action was unsafe.",
                        level: "warning",
                    },
                },
            },
        });

        const unavailable = projectSessionEvent(
            permissionEvent({
                type: "permission_action_unproven",
                agentId: "agent-1",
                callId: "call-1",
                tool: "publish",
                action: "Publish to /tmp/out, outside the workspace.",
                kind: "unavailable",
                reason: "This agent has no permission reviewer.",
            }),
            SESSION_ID,
        );

        expect(unavailable).toMatchObject({
            type: "system_notice",
            data: {
                message: {
                    structured: {
                        kind: "notice",
                        title: "Automatic permission review could not run",
                        details:
                            "The action was not performed because no reliable automatic permission decision was available. No judgment was made about the action itself.",
                        level: "warning",
                    },
                },
            },
        });
    });

    it("projects a stopped turn to the exact warning notice", () => {
        const stopped = projectSessionEvent(
            permissionEvent({
                type: "permission_turn_stopped",
                agentId: "agent-1",
                consecutiveRefusals: 3,
                recentRefusals: 3,
                recentWindowLength: 3,
                reason:
                    "Automatic permission review refused too many actions in this turn (3 in a row, 3 of the last 3), so the turn was stopped. Tell the user what you were trying to do and why it kept being refused.",
            }),
            SESSION_ID,
        );

        expect(stopped).toEqual({
            createdAt: 1_000,
            id: "event-1",
            sessionId: SESSION_ID,
            worktreeSupport: "unknown",
            type: "system_notice",
            data: {
                message: {
                    role: "system",
                    id: "event-1",
                    context: "excluded",
                    blocks: [
                        {
                            type: "text",
                            text: "Automatic permission review refused too many actions in this turn (3 in a row, 3 of the last 3), so the turn was stopped.",
                        },
                    ],
                    structured: {
                        kind: "notice",
                        title: "Automatic permission review stopped the turn",
                        details:
                            "Automatic permission review refused too many actions in this turn (3 in a row, 3 of the last 3), so the turn was stopped.",
                        level: "warning",
                        code: "permission_turn_stopped",
                    },
                },
            },
        });
    });

    it("projects a failed cleanup to an English system notice", () => {
        const cleanup = projectSessionEvent(
            permissionEvent({
                type: "permission_mode_cleanup_failed",
                agentId: "agent-1",
                previousMode: "auto",
                mode: "read_only",
                reason: "shell cleanup unavailable",
            }),
            SESSION_ID,
        );

        expect(cleanup).toMatchObject({
            type: "system_notice",
            data: {
                message: {
                    structured: {
                        kind: "notice",
                        title: "Permission cleanup failed",
                        details:
                            "Rig could not stop every elevated process after permissions were reduced. shell cleanup unavailable",
                        level: "warning",
                    },
                },
            },
        });
    });

    it("drops a permission event whose payload does not match the schema", () => {
        // Finding 6: the stored payload is arbitrary JSON, so it is validated against the real
        // schema before any field is read. A corrupt turn-stop event (a negative window can never
        // be produced by the module) must be dropped, not rendered as "-1 of the last -1".
        expect(
            projectSessionEvent(
                permissionEvent({
                    type: "permission_turn_stopped",
                    agentId: "agent-1",
                    consecutiveRefusals: 3,
                    recentRefusals: 3,
                    recentWindowLength: -1,
                    reason: "corrupt window",
                }),
                SESSION_ID,
            ),
        ).toBeUndefined();

        expect(
            projectSessionEvent(
                permissionEvent({ type: "not_a_permission_event", agentId: "agent-1" }),
                SESSION_ID,
            ),
        ).toBeUndefined();
    });

    it("streams the turn-stop notice before the aborted run it explains", () => {
        // The turn-stop notice and the aborted run's terminal event are two separate records. A
        // client suppresses its generic interruption row for the run only if the explaining notice
        // has already arrived, so the projected order must place the notice first.
        const stopped = projectSessionEvent(
            permissionEvent(
                {
                    type: "permission_turn_stopped",
                    agentId: "agent-1",
                    consecutiveRefusals: 3,
                    recentRefusals: 3,
                    recentWindowLength: 3,
                    reason: "too many refusals",
                },
                "stop-event",
            ),
            SESSION_ID,
        );
        const aborted = projectSessionEvent(
            {
                agentId: "agent-1",
                id: "settle-event",
                occurredAt: 2_000,
                payload: { runId: "run-1", stopReason: "aborted" },
                type: "loop.settled",
            },
            SESSION_ID,
        );

        expect(stopped?.type).toBe("system_notice");
        expect(aborted).toMatchObject({ type: "run_finished", data: { stopReason: "aborted" } });

        const ordered = [stopped, aborted].filter(
            (event): event is Record<string, unknown> => event !== undefined,
        );
        const noticeIndex = ordered.findIndex((event) => event.type === "system_notice");
        const finishedIndex = ordered.findIndex((event) => event.type === "run_finished");
        expect(noticeIndex).toBeGreaterThanOrEqual(0);
        expect(finishedIndex).toBeGreaterThanOrEqual(0);
        expect(noticeIndex).toBeLessThan(finishedIndex);
    });

    it("preserves the turn-stop notice ahead of a bounded reload window", () => {
        // Finding 5: reload delivers only the newest events. A busy tail could otherwise push the
        // explaining notice out of the window and leave the aborted run unexplained. The initial
        // window restores dropped system notices ahead of the tail so the explanation survives.
        const notice = projectSessionEvent(
            permissionEvent(
                {
                    type: "permission_turn_stopped",
                    agentId: "agent-1",
                    consecutiveRefusals: 3,
                    recentRefusals: 3,
                    recentWindowLength: 3,
                    reason: "too many refusals",
                },
                "old-notice",
            ),
            SESSION_ID,
        );
        expect(notice).toBeDefined();
        const tail: Record<string, unknown>[] = [];
        for (let index = 0; index < 5; index += 1) {
            tail.push({ id: `tail-${index}`, type: "agent_message", data: {} });
        }
        const projected = [notice as Record<string, unknown>, ...tail];

        const windowed = initialEventWindow(projected, 3);
        expect(windowed[0]).toBe(notice);
        expect(windowed.some((event) => event.id === "old-notice")).toBe(true);
        // The window still ends with the newest tail events.
        expect(windowed[windowed.length - 1]).toMatchObject({ id: "tail-4" });
    });

    it("does not project a plain mode change or an out-of-mode refusal", () => {
        expect(
            projectSessionEvent(
                permissionEvent({
                    type: "permission_mode_changed",
                    agentId: "agent-1",
                    previousMode: "auto",
                    mode: "read_only",
                }),
                SESSION_ID,
            ),
        ).toBeUndefined();
        expect(
            projectSessionEvent(
                permissionEvent({
                    type: "permission_action_out_of_mode",
                    agentId: "agent-1",
                    callId: "call-1",
                    tool: "call_server",
                    mode: "read_only",
                }),
                SESSION_ID,
            ),
        ).toBeUndefined();
    });
});
