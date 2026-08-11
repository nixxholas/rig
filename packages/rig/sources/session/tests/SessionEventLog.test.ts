import { describe, expect, it, vi } from "vitest";
import type { Span, Tracer } from "@opentelemetry/api";

import { createEventIdFactory, type SessionEvent } from "../../protocol/index.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { SessionEventLog } from "../SessionEventLog.js";

const ctx = createTestRootContext();

const FIRST = "018bcfe5-6800-7001-8000-00000000aaaa";
const OMITTED = "018bcfe5-6800-7002-8000-00000000aaaa";
const DURABLE = "018bcfe5-6800-7003-8000-00000000aaaa";
const OTHER_SESSION = "018bcfe5-6800-7002-8000-00000000bbbb";
const FUTURE = "018bcfe5-6800-7005-8000-00000000aaaa";

describe("SessionEventLog", () => {
    it("can defer subscriber delivery until durable work commits", async () => {
        const pending: (() => void | Promise<void>)[] = [];
        const observed: SessionEvent[] = [];
        const log = new SessionEventLog({
            deferNotification: (_ctx, notify) => {
                pending.push(notify);
            },
        });
        log.subscribe((next) => {
            observed.push(next);
        });

        const appended = event(FIRST);
        await log.append(ctx, appended);

        expect(observed).toEqual([]);
        expect(pending).toHaveLength(1);
        await pending[0]?.();
        expect(observed).toEqual([appended]);
    });

    it("waits for durable persistence before memory, notifications, and transaction completion", async () => {
        let releasePersistence!: () => void;
        let markPersistenceStarted!: () => void;
        const persistenceStarted = new Promise<void>((resolve) => {
            markPersistenceStarted = resolve;
        });
        const persistence = new Promise<void>((resolve) => {
            releasePersistence = resolve;
        });
        const pending: (() => void | Promise<void>)[] = [];
        const observed: SessionEvent[] = [];
        let transactionCompleted = false;
        let notificationBeforeCommit = false;
        const log = new SessionEventLog({
            deferNotification: (_ctx, notify) => {
                pending.push(notify);
            },
            onAppend: async () => {
                markPersistenceStarted();
                await persistence;
            },
        });
        log.subscribe((next) => {
            if (!transactionCompleted) notificationBeforeCommit = true;
            observed.push(next);
        });

        const transaction = (async () => {
            await log.append(ctx, event(DURABLE));
            transactionCompleted = true;
            for (const notify of pending) await notify();
        })();

        await persistenceStarted;
        expect(log.all()).toEqual([]);
        expect(observed).toEqual([]);
        expect(pending).toHaveLength(0);
        expect(transactionCompleted).toBe(false);

        releasePersistence();
        await transaction;

        expect(log.all()).toEqual([event(DURABLE)]);
        expect(transactionCompleted).toBe(true);
        expect(notificationBeforeCommit).toBe(false);
        expect(observed).toEqual([event(DURABLE)]);
    });

    it("leaves no in-memory event or notification when durable persistence rejects", async () => {
        const failure = new Error("persistence append failed");
        const pending: (() => void | Promise<void>)[] = [];
        const observed: SessionEvent[] = [];
        const log = new SessionEventLog({
            deferNotification: (_ctx, notify) => {
                pending.push(notify);
            },
            onAppend: async () => {
                throw failure;
            },
        });
        log.subscribe((next) => {
            observed.push(next);
        });

        await expect(log.append(ctx, event(DURABLE))).rejects.toBe(failure);

        expect(log.all()).toEqual([]);
        expect(log.lastEventId()).toBeUndefined();
        expect(log.revision()).toBe(0);
        expect(observed).toEqual([]);
        expect(pending).toHaveLength(0);
    });

    it("serializes concurrent durable appends and notifications in arrival order", async () => {
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstPersistence = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const persisted: string[] = [];
        const observed: string[] = [];
        const first = event(FIRST);
        const second = event(DURABLE);
        const log = new SessionEventLog({
            onAppend: async (_ctx, next) => {
                persisted.push(next.id);
                if (next.id === first.id) {
                    markFirstStarted();
                    await firstPersistence;
                }
            },
        });
        log.subscribe((next) => {
            observed.push(next.id);
        });

        const firstAppend = log.append(ctx, first);
        const secondAppend = log.append(ctx, second);
        await firstStarted;

        expect(persisted).toEqual([first.id]);
        expect(log.all()).toEqual([]);
        expect(observed).toEqual([]);

        releaseFirst();
        await Promise.all([firstAppend, secondAppend]);

        expect(persisted).toEqual([first.id, second.id]);
        expect(log.all().map((next) => next.id)).toEqual([first.id, second.id]);
        expect(observed).toEqual([first.id, second.id]);
    });

    it("does not hold the state lock while an external subscriber is still running", async () => {
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstNotification = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const spans = spanLifecycleTracer();
        const tracedCtx = createTestRootContext(spans.tracer);
        const observed: string[] = [];
        const first = event(FIRST);
        const second = event(DURABLE);
        const log = new SessionEventLog();
        log.subscribe(async (next) => {
            observed.push(next.id);
            if (next.id !== first.id) return;
            markFirstStarted();
            await firstNotification;
        });

        const firstAppend = log.append(tracedCtx, first);
        await firstStarted;
        const secondAppend = log.append(tracedCtx, second);

        await expect(
            waitForEventsWithoutStateLock(log, [first, second], spans.active),
        ).resolves.toBeUndefined();
        expect(spans.active()).not.toContain("asyncLock.wait");

        releaseFirst();
        await Promise.all([firstAppend, secondAppend]);
        expect(observed).toEqual([first.id, second.id]);
    });

    it("lets a subscriber append and await another event without locking itself", async () => {
        const spans = spanLifecycleTracer();
        const tracedCtx = createTestRootContext(spans.tracer);
        const observed: string[] = [];
        const first = event(FIRST);
        const second = event(DURABLE);
        const log = new SessionEventLog();
        log.subscribe(async (next) => {
            observed.push(next.id);
            if (next.id === first.id) await log.append(tracedCtx, second);
        });

        await expect(log.append(tracedCtx, first)).resolves.toBe(first);

        expect(log.all()).toEqual([first, second]);
        expect(observed).toEqual([first.id, second.id]);
        expect(spans.active()).not.toContain("asyncLock.wait");
    });

    it("offers reducers one allocation-free read-only view of a long log", async () => {
        const log = new SessionEventLog();
        const view = log.all();
        await log.append(ctx, event("event-1"));

        expect(log.all()).toBe(view);
        expect(view.map((entry) => entry.id)).toEqual(["event-1"]);
    });

    it("isolates subscriber failures from durable event delivery", async () => {
        const delivered: SessionEvent[] = [];
        const log = new SessionEventLog();
        log.subscribe(() => {
            throw new Error("disconnected subscriber");
        });
        log.subscribe((next) => {
            delivered.push(next);
        });
        const next = event(FIRST);

        await expect(log.append(ctx, next)).resolves.toBe(next);
        expect(delivered).toEqual([next]);
        expect(log.since(undefined)).toEqual([next]);
    });

    it("recovers an omitted ordered cursor without replaying its durable predecessor", async () => {
        const log = new SessionEventLog({
            events: [event(FIRST)],
            lastEventId: OMITTED,
        });
        await log.append(ctx, event(DURABLE));

        expect(log.since(OMITTED)?.map((entry) => entry.id)).toEqual([DURABLE]);
        expect(log.since(DURABLE)).toEqual([]);
    });

    it("rejects cursors that were not omitted from this session", async () => {
        const log = new SessionEventLog({
            events: [event(FIRST), event(DURABLE)],
            lastEventId: DURABLE,
        });

        expect(log.since("not-an-event-id")).toBeUndefined();
        expect(log.since("018bcfe5-6800-7000-8000-000000000000")).toBeUndefined();
        expect(log.since(OTHER_SESSION)).toBeUndefined();
        expect(log.since(FUTURE)).toBeUndefined();
    });

    it("updates the cursor high-water while delivering appended events to subscribers", async () => {
        const listener = vi.fn();
        const log = new SessionEventLog({ events: [event(FIRST)] });
        log.subscribe(listener);

        await log.append(ctx, event(DURABLE));

        expect(log.lastEventId()).toBe(DURABLE);
        expect(listener).toHaveBeenCalledExactlyOnceWith(event(DURABLE));
    });

    it("replays a block reset after a disconnected client saw tentative output", async () => {
        const log = new SessionEventLog({ events: [event(FIRST)] });
        const reset = blockResetEvent(DURABLE);

        await log.append(ctx, transientEvent(OMITTED, "tentative"));
        await log.append(ctx, reset);

        expect(log.since(OMITTED)).toEqual([reset]);
        expect(log.since(undefined)).toContainEqual(reset);
    });

    it("indexes durable message submissions from restored and appended events", async () => {
        const restored = messageSubmittedEvent(FIRST, "restored-message");
        const appended = messageSubmittedEvent(DURABLE, "appended-message");
        const log = new SessionEventLog({ events: [restored] });

        await log.append(ctx, appended);

        expect(log.messageSubmission("restored-message")).toEqual(restored);
        expect(log.messageSubmission("appended-message")).toEqual(appended);
        expect(log.messageSubmission("missing-message")).toBeUndefined();
    });

    it("indexes when steering was applied rather than when its message was queued", async () => {
        const log = new SessionEventLog({
            events: [steeringAppliedEvent(FIRST, ["steer-restored"], 1_700_000_010_000)],
        });

        await log.append(
            ctx,
            steeringAppliedEvent(DURABLE, ["steer-one", "steer-two"], 1_700_000_020_000),
        );

        expect(log.messageSteeredAt("steer-restored")).toBe(1_700_000_010_000);
        expect(log.messageSteeredAt("steer-one")).toBe(1_700_000_020_000);
        expect(log.messageSteeredAt("steer-two")).toBe(1_700_000_020_000);
    });

    it("forgets submission idempotency entries when their retained event expires", async () => {
        const submission = messageSubmittedEvent(FIRST, "expired-message");
        const log = new SessionEventLog({ retentionLimit: 1 });

        await log.append(ctx, submission);
        await log.append(ctx, event(DURABLE));

        expect(log.messageSubmission("expired-message")).toBeUndefined();
    });

    it("indexes historical permission reviews for transcript pages", async () => {
        const log = new SessionEventLog({
            events: [permissionReviewEvent(FIRST, "tool-old")],
        });
        await log.append(ctx, permissionReviewEvent(DURABLE, "tool-new"));

        expect(log.permissionReviews(new Set(["tool-old", "tool-new", "missing"]))).toEqual([
            expect.objectContaining({ toolCallId: "tool-old" }),
            expect.objectContaining({ toolCallId: "tool-new" }),
        ]);
    });

    it("records temporary Full access only after the execution boundary starts", async () => {
        const log = new SessionEventLog({
            events: [
                permissionReviewEvent(FIRST, "tool-reviewed"),
                temporaryFullAccessStartedEvent(OMITTED, "tool-reviewed"),
            ],
        });

        expect(log.permissionReviews(new Set(["tool-reviewed"]))).toEqual([
            expect.objectContaining({
                fullAccessGranted: true,
                toolCallId: "tool-reviewed",
            }),
        ]);
    });

    it("reconstructs a temporary Full-access review across the retention boundary", async () => {
        const events = [
            permissionReviewEvent(FIRST, "tool-reviewed"),
            temporaryFullAccessStartedEvent(OMITTED, "tool-reviewed"),
        ];
        const incremental = new SessionEventLog({ retentionLimit: 1 });
        for (const event of events) await incremental.append(ctx, event);
        const reconstructed = new SessionEventLog({ events, retentionLimit: 1 });

        expect(reconstructed.permissionReviews(new Set(["tool-reviewed"]))).toEqual(
            incremental.permissionReviews(new Set(["tool-reviewed"])),
        );
        expect(reconstructed.permissionReviews(new Set(["tool-reviewed"]))).toEqual([
            expect.objectContaining({
                action: "Run tests",
                decision: "allow",
                fullAccessGranted: true,
                reason: "The user explicitly requested verification.",
                risk: "low",
                toolCallId: "tool-reviewed",
                userAuthorization: "high",
            }),
        ]);
    });

    it("retains the oldest durable message time independently of earlier session events", async () => {
        const firstMessage = messageSubmittedEvent(FIRST, "first-message", 1_700_000_100_000);
        const laterMessage = messageSubmittedEvent(DURABLE, "later-message", 1_700_000_200_000);
        const log = new SessionEventLog({ events: [event(OMITTED), firstMessage, laterMessage] });

        expect(log.firstMessageCreatedAt()).toBe(1_700_000_100_000);
    });

    it("drops transient payloads while preserving delivery, final state, and every scoped cursor", async () => {
        const listener = vi.fn();
        const createId = createEventIdFactory({ now: () => 1_700_000_000_000 });
        const first = createId();
        const log = new SessionEventLog({ events: [event(first)] });
        log.subscribe(listener);
        const transientIds: string[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            const id = createId();
            transientIds.push(id);
            await log.append(ctx, transientEvent(id, String(index)));
        }
        const durable = event(createId());
        await log.append(ctx, durable);

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

function temporaryFullAccessStartedEvent(id: string, toolCallId: string): SessionEvent {
    return {
        createdAt: 1_700_000_000_000,
        data: {
            event: {
                action: "Run tests",
                reason: "The user explicitly requested verification.",
                risk: "low",
                toolCallId,
                type: "temporary_full_access_started",
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

function spanLifecycleTracer(): {
    active(): string[];
    tracer: Tracer;
} {
    const active = new Map<string, number>();
    return {
        active: () =>
            [...active].flatMap(([name, count]) => Array.from({ length: count }, () => name)),
        tracer: {
            startSpan: (name: string) => {
                active.set(name, (active.get(name) ?? 0) + 1);
                return {
                    end: () => {
                        const remaining = (active.get(name) ?? 1) - 1;
                        if (remaining === 0) active.delete(name);
                        else active.set(name, remaining);
                    },
                    recordException: () => undefined,
                    setStatus: () => undefined,
                } as unknown as Span;
            },
        } as Tracer,
    };
}

async function waitForEventsWithoutStateLock(
    log: SessionEventLog,
    events: readonly SessionEvent[],
    activeSpans: () => string[],
): Promise<void> {
    try {
        await vi.waitFor(() => expect(log.all()).toEqual(events), { timeout: 200 });
    } catch {
        throw new Error(`Event state timed out; active spans: ${activeSpans().join(", ")}`);
    }
}
