import { describe, expect, it, vi } from "vitest";

import { createEventIdFactory, type SessionEvent } from "../protocol/index.js";
import { SessionEventLog } from "./SessionEventLog.js";

const FIRST = "018bcfe5-6800-7001-8000-00000000aaaa";
const OMITTED = "018bcfe5-6800-7002-8000-00000000aaaa";
const DURABLE = "018bcfe5-6800-7003-8000-00000000aaaa";
const OTHER_SESSION = "018bcfe5-6800-7002-8000-00000000bbbb";
const FUTURE = "018bcfe5-6800-7005-8000-00000000aaaa";

describe("SessionEventLog", () => {
    it("offers reducers one allocation-free read-only view of a long log", () => {
        const log = new SessionEventLog();
        const view = log.all();
        log.append(event("event-1"));

        expect(log.all()).toBe(view);
        expect(view.map((entry) => entry.id)).toEqual(["event-1"]);
    });

    it("isolates subscriber failures from durable event delivery", () => {
        const delivered: SessionEvent[] = [];
        const log = new SessionEventLog();
        log.subscribe(() => {
            throw new Error("disconnected subscriber");
        });
        log.subscribe((next) => delivered.push(next));
        const next = event(FIRST);

        expect(() => log.append(next)).not.toThrow();
        expect(delivered).toEqual([next]);
        expect(log.since(undefined)).toEqual([next]);
    });

    it("recovers an omitted ordered cursor without replaying its durable predecessor", () => {
        const log = new SessionEventLog({
            events: [event(FIRST)],
            lastEventId: OMITTED,
        });
        log.append(event(DURABLE));

        expect(log.since(OMITTED)?.map((entry) => entry.id)).toEqual([DURABLE]);
        expect(log.since(DURABLE)).toEqual([]);
    });

    it("rejects cursors that were not omitted from this session", () => {
        const log = new SessionEventLog({
            events: [event(FIRST), event(DURABLE)],
            lastEventId: DURABLE,
        });

        expect(log.since("not-an-event-id")).toBeUndefined();
        expect(log.since("018bcfe5-6800-7000-8000-000000000000")).toBeUndefined();
        expect(log.since(OTHER_SESSION)).toBeUndefined();
        expect(log.since(FUTURE)).toBeUndefined();
    });

    it("updates the cursor high-water while delivering appended events to subscribers", () => {
        const listener = vi.fn();
        const log = new SessionEventLog({ events: [event(FIRST)] });
        log.subscribe(listener);

        log.append(event(DURABLE));

        expect(log.lastEventId()).toBe(DURABLE);
        expect(listener).toHaveBeenCalledExactlyOnceWith(event(DURABLE));
    });

    it("replays a block reset after a disconnected client saw tentative output", () => {
        const log = new SessionEventLog({ events: [event(FIRST)] });
        const reset = blockResetEvent(DURABLE);

        log.append(transientEvent(OMITTED, "tentative"));
        log.append(reset);

        expect(log.since(OMITTED)).toEqual([reset]);
        expect(log.since(undefined)).toContainEqual(reset);
    });

    it("indexes durable message submissions from restored and appended events", () => {
        const restored = messageSubmittedEvent(FIRST, "restored-message");
        const appended = messageSubmittedEvent(DURABLE, "appended-message");
        const log = new SessionEventLog({ events: [restored] });

        log.append(appended);

        expect(log.messageSubmission("restored-message")).toEqual(restored);
        expect(log.messageSubmission("appended-message")).toEqual(appended);
        expect(log.messageSubmission("missing-message")).toBeUndefined();
    });

    it("indexes when steering was applied rather than when its message was queued", () => {
        const log = new SessionEventLog({
            events: [steeringAppliedEvent(FIRST, ["steer-restored"], 1_700_000_010_000)],
        });

        log.append(steeringAppliedEvent(DURABLE, ["steer-one", "steer-two"], 1_700_000_020_000));

        expect(log.messageSteeredAt("steer-restored")).toBe(1_700_000_010_000);
        expect(log.messageSteeredAt("steer-one")).toBe(1_700_000_020_000);
        expect(log.messageSteeredAt("steer-two")).toBe(1_700_000_020_000);
    });

    it("forgets submission idempotency entries when their retained event expires", () => {
        const submission = messageSubmittedEvent(FIRST, "expired-message");
        const log = new SessionEventLog({ retentionLimit: 1 });

        log.append(submission);
        log.append(event(DURABLE));

        expect(log.messageSubmission("expired-message")).toBeUndefined();
    });

    it("indexes historical permission reviews for transcript pages", () => {
        const log = new SessionEventLog({
            events: [permissionReviewEvent(FIRST, "tool-old")],
        });
        log.append(permissionReviewEvent(DURABLE, "tool-new"));

        expect(log.permissionReviews(new Set(["tool-old", "tool-new", "missing"]))).toEqual([
            expect.objectContaining({ toolCallId: "tool-old" }),
            expect.objectContaining({ toolCallId: "tool-new" }),
        ]);
    });

    it("retains the oldest durable message time independently of earlier session events", () => {
        const firstMessage = messageSubmittedEvent(FIRST, "first-message", 1_700_000_100_000);
        const laterMessage = messageSubmittedEvent(DURABLE, "later-message", 1_700_000_200_000);
        const log = new SessionEventLog({ events: [event(OMITTED), firstMessage, laterMessage] });

        expect(log.firstMessageCreatedAt()).toBe(1_700_000_100_000);
    });

    it("drops transient payloads while preserving delivery, final state, and every scoped cursor", () => {
        const listener = vi.fn();
        const createId = createEventIdFactory({ now: () => 1_700_000_000_000 });
        const first = createId();
        const log = new SessionEventLog({ events: [event(first)] });
        log.subscribe(listener);
        const transientIds: string[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            const id = createId();
            transientIds.push(id);
            log.append(transientEvent(id, String(index)));
        }
        const durable = event(createId());
        log.append(durable);

        const retained = log.since(undefined) ?? [];
        expect(listener).toHaveBeenCalledTimes(10_001);
        expect(retained.filter((entry) => entry.type === "agent_event")).toEqual([]);
        expect(retained.at(-1)).toEqual(durable);
        expect(log.since(transientIds.at(0))?.map((entry) => entry.id)).toEqual([durable.id]);
        expect(log.since(transientIds.at(5_000))?.map((entry) => entry.id)).toEqual([durable.id]);
        expect(log.since(transientIds.at(-1))?.map((entry) => entry.id)).toEqual([durable.id]);
        expect(log.lastEventId()).toBe(durable.id);
    });
});

function event(id: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            snapshot: {
                id: "agent-1",
                messages: [],
                modelId: "openai/gpt-5.5",
                providerId: "codex",
                queue: [],
                status: "idle",
                tools: [],
            },
            // These exercise event delivery, not transcript rebuilding.
            transcript: { complete: true, messages: [], turns: [] },
        },
        id,
        sessionId: "session-1",
        type: "session_reset",
    };
}

function messageSubmittedEvent(
    id: string,
    messageId: string,
    createdAt = 1_700_000_000_000,
): SessionEvent {
    return {
        createdAt,
        data: {
            delivery: "run",
            displayText: "Continue.",
            message: {
                blocks: [{ text: "Continue.", type: "text" }],
                id: messageId,
                role: "user",
            },
            runId: "run-1",
        },
        id,
        sessionId: "session-1",
        type: "message_submitted",
    };
}

function steeringAppliedEvent(
    id: string,
    messageIds: readonly string[],
    createdAt: number,
): SessionEvent {
    return {
        createdAt,
        data: { messageIds, runId: "run-1" },
        id,
        sessionId: "session-1",
        type: "steering_applied",
    };
}

function permissionReviewEvent(id: string, toolCallId: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            event: {
                action: "Run command",
                decision: "allow",
                reason: "Requested",
                risk: "low",
                toolCallId,
                type: "permission_review",
                userAuthorization: "high",
            },
            runId: "run-1",
        },
        id,
        sessionId: "session-1",
        type: "agent_event",
    };
}

function transientEvent(id: string, delta: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            event: { contentIndex: 0, delta, partial: {}, type: "text_delta" },
            runId: "run-1",
        },
        id,
        sessionId: "session-1",
        type: "agent_event",
    } as SessionEvent;
}

function blockResetEvent(id: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            event: {
                messageId: "message-1",
                partial: {
                    api: "test",
                    content: [],
                    model: "openai/test",
                    provider: "codex",
                    role: "assistant",
                    stopReason: "stop",
                    timestamp: 1_700_000_000_000,
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 0,
                        output: 0,
                        totalTokens: 0,
                    },
                },
                type: "block_reset",
            },
            runId: "run-1",
        },
        id,
        sessionId: "session-1",
        type: "agent_event",
    };
}
