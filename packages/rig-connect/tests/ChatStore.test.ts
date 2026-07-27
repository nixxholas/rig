import { describe, expect, it } from "vitest";

import { ChatStore } from "@/ChatStore.js";
import type { ChatDelta, ChatElement, ToolCallElement } from "@/ChatElement.js";
import type { AgentLoopEvent, Message, SessionEvent, SessionStreamHello } from "@/protocol.js";

let clock = 0;

function event<TType extends string>(type: TType, data: unknown): SessionEvent {
    clock += 1;
    return {
        createdAt: clock,
        data,
        id: `event-${clock}`,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}

function agentEvent(inner: AgentLoopEvent): SessionEvent {
    return event("agent_event", { event: inner, runId: "run-1" });
}

function hello(overrides: Partial<SessionStreamHello> = {}): SessionStreamHello {
    return {
        activity: { kind: "idle", label: "Idle", since: 0 },
        resumed: false,
        session: {
            activity: { kind: "idle", label: "Idle", since: 0 },
            archived: false,
            cwd: "/work",
            id: "session-1",
            modelLocked: false,
            modelId: "sonnet-5",
            models: [],
            orderKey: "a0",
            pendingUserInputs: [],
            permissionMode: "auto",
            projectId: "project-1",
            providerId: "claude",
            snapshot: { messages: [] },
            status: "idle",
            tasks: [],
        },
        ...overrides,
    };
}

/** Runs a turn with one assistant message and one tool call. */
function runOneTurn(store: ChatStore): ChatDelta[] {
    const deltas: ChatDelta[] = [];
    const push = (applied: readonly ChatDelta[]) => deltas.push(...applied);
    push(store.apply(event("run_started", { runId: "run-1" })));
    push(
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        ),
    );
    push(store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" })));
    push(
        store.apply(
            agentEvent({ contentIndex: 0, delta: "Let me ", messageId: "m1", type: "text_delta" }),
        ),
    );
    push(
        store.apply(
            agentEvent({ contentIndex: 0, delta: "check.", messageId: "m1", type: "text_delta" }),
        ),
    );
    push(
        store.apply(
            agentEvent({
                content: "Let me check.",
                contentIndex: 0,
                messageId: "m1",
                type: "text_end",
            }),
        ),
    );
    push(
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: { command: "ls" },
                    id: "call-1",
                    name: "Bash",
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        ),
    );
    push(
        store.apply(
            agentEvent({
                result: {
                    display: "3 files",
                    isError: false,
                    toolCallId: "call-1",
                    toolName: "Bash",
                },
                type: "tool_execution_end",
            }),
        ),
    );
    push(store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" })));
    return deltas;
}

describe("ChatStore", () => {
    it("builds a flat, time-ordered list with one element per message, block, and tool call", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        expect(store.elements().map((element) => element.kind)).toEqual([
            "agent_text",
            "tool_call",
            "turn_end",
        ]);
    });

    it("gives every element the turn it belongs to", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        expect(store.elements().every((element) => element.turnId === "run-1")).toBe(true);
    });

    it("always ends a turn with a final element that states the outcome", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        const last = store.elements().at(-1);
        expect(last).toMatchObject({ kind: "turn_end", outcome: "success" });
    });

    it("keeps authoritative active turn timing through steering and activity changes", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const submitted = event("message_submitted", {
            delivery: "run",
            displayText: "Start",
            message: {
                blocks: [{ text: "Start", type: "text" }],
                id: "user-1",
                role: "user",
            },
            runId: "run-1",
        });
        store.apply(submitted);

        expect(store.session()).toMatchObject({
            activeTurn: { startedAt: submitted.createdAt, turnId: "run-1" },
        });

        store.apply(
            event("message_submitted", {
                delivery: "steer",
                displayText: "Continue",
                message: {
                    blocks: [{ text: "Continue", type: "text" }],
                    id: "steer-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        store.apply(
            event("session_activity_changed", {
                activity: { kind: "thinking", label: "Thinking", since: 99 },
            }),
        );
        store.applyHello({
            activity: { kind: "executing_tool_call", label: "Running a tool", since: 120 },
            resumed: true,
        });

        expect(store.session()).toMatchObject({
            activeTurn: { startedAt: submitted.createdAt, turnId: "run-1" },
        });
    });

    it("pins pending steering as one message bubble and restores chronological order on acceptance", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            event("message_submitted", {
                delivery: "steer",
                displayText: "Check this too",
                message: {
                    blocks: [{ text: "Check this too", type: "text" }],
                    id: "steer-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        const stableId = store.elements().at(-1)?.id;
        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "Still working",
                messageId: "agent-live",
                type: "text_delta",
            }),
        );

        expect(store.elements().at(-1)).toMatchObject({
            delivery: "pending_steering",
            id: stableId,
            kind: "user_message",
            messageId: "steer-1",
        });
        expect(
            store
                .elements()
                .filter(
                    (element) => element.kind === "user_message" && element.messageId === "steer-1",
                ),
        ).toHaveLength(1);

        store.apply(event("steering_applied", { messageIds: ["steer-1"], runId: "run-1" }));

        const acceptedIndex = store.elements().findIndex((element) => element.id === stableId);
        const laterAgentIndex = store
            .elements()
            .findIndex((element) => element.id === "agent-live:agent_text:0");
        expect(store.elements()[acceptedIndex]).toMatchObject({
            delivery: "sent",
            id: stableId,
            messageId: "steer-1",
        });
        expect(acceptedIndex).toBeLessThan(laterAgentIndex);
    });

    it("keeps multiple steering bubbles in queue order through back-to-back acceptance", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        for (const id of ["steer-1", "steer-2"]) {
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: id,
                    message: {
                        blocks: [{ text: id, type: "text" }],
                        id,
                        role: "user",
                    },
                    runId: "run-1",
                }),
            );
        }
        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "New work",
                messageId: "agent-after-steering",
                type: "text_delta",
            }),
        );

        expect(
            store
                .elements()
                .slice(-2)
                .map((element) =>
                    element.kind === "user_message" ? element.messageId : element.kind,
                ),
        ).toEqual(["steer-1", "steer-2"]);

        store.apply(event("steering_applied", { messageIds: ["steer-1"], runId: "run-1" }));
        expect(store.elements().at(-1)).toMatchObject({
            delivery: "pending_steering",
            messageId: "steer-2",
        });
        store.apply(event("steering_applied", { messageIds: ["steer-2"], runId: "run-1" }));

        const order = store
            .elements()
            .filter((element) => element.kind === "user_message")
            .map((element) => [element.messageId, element.delivery]);
        expect(order).toEqual([
            ["steer-1", "sent"],
            ["steer-2", "sent"],
        ]);
        expect(store.elements().at(-1)?.kind).toBe("agent_text");
    });

    it("rebuilds pending steering once at the transcript tail on attach", () => {
        const opening = hello();
        const committed = {
            blocks: [{ text: "Working", type: "text" as const }],
            id: "agent-before-pending",
            role: "agent" as const,
        };
        const store = new ChatStore("session-1");
        const recovered: SessionStreamHello = {
            ...opening,
            session: {
                ...opening.session!,
                snapshot: { messages: [committed] },
                pendingSteeringMessages: [
                    {
                        createdAt: 3_000,
                        message: {
                            blocks: [{ text: "Queued", type: "text" as const }],
                            id: "steer-recovered",
                            role: "user" as const,
                        },
                        runId: "run-2",
                    },
                ],
            },
            transcript: {
                complete: true,
                messageCreatedAt: { "agent-before-pending": 2_000 },
                messages: [committed],
                turns: [
                    {
                        messageIds: ["agent-before-pending"],
                        runId: "run-2",
                        startedAt: 1_000,
                    },
                ],
            },
        };
        store.applyHello(recovered);

        expect(store.elements().at(-1)).toMatchObject({
            createdAt: 3_000,
            delivery: "pending_steering",
            messageId: "steer-recovered",
        });
        expect(
            store
                .elements()
                .filter(
                    (element) =>
                        element.kind === "user_message" && element.messageId === "steer-recovered",
                ),
        ).toHaveLength(1);
        const pendingBeforeReconnect = store.elements().at(-1);
        store.applyHello(recovered);
        expect(store.elements().at(-1)).toBe(pendingBeforeReconnect);
    });

    it("attaches restored permission reviews to their historical tool calls", () => {
        const opening = hello();
        const message = {
            blocks: [
                {
                    arguments: { command: "pnpm test" },
                    id: "reviewed-call",
                    name: "exec_command",
                    type: "tool_call" as const,
                },
            ],
            id: "agent-reviewed",
            role: "agent" as const,
        };
        const store = new ChatStore("session-1");
        const recovered: SessionStreamHello = {
            ...opening,
            session: {
                ...opening.session!,
                permissionReviews: [
                    {
                        action: "Run tests",
                        decision: "allow",
                        reason: "Requested",
                        risk: "low",
                        toolCallId: "reviewed-call",
                        userAuthorization: "high",
                    },
                ],
                snapshot: { messages: [message] },
            },
            transcript: {
                complete: true,
                messages: [message],
                turns: [
                    {
                        messageIds: [message.id],
                        runId: "run-reviewed",
                        startedAt: 1,
                    },
                ],
            },
        };
        store.applyHello(recovered);

        expect(
            store.elements().find((element) => element.id === "tool:reviewed-call"),
        ).toMatchObject({
            permissionReview: {
                decision: "allow",
                toolCallId: "reviewed-call",
                userAuthorization: "high",
            },
        });
        const reviewedBeforeRecovery = store
            .elements()
            .find((element) => element.id === "tool:reviewed-call");
        store.applyHello(recovered);
        expect(store.elements().find((element) => element.id === "tool:reviewed-call")).toBe(
            reviewedBeforeRecovery,
        );
        const pagedMessage: Message = {
            blocks: [
                {
                    arguments: { path: "README.md" },
                    id: "paged-reviewed-call",
                    name: "read",
                    type: "tool_call",
                },
            ],
            id: "agent-paged-reviewed",
            role: "agent",
        };
        store.prependEarlier({
            complete: true,
            messages: [pagedMessage],
            permissionReviews: [
                {
                    action: "Read history",
                    decision: "allow",
                    reason: "Requested",
                    risk: "low",
                    toolCallId: "paged-reviewed-call",
                    userAuthorization: "high",
                },
            ],
            turns: [
                {
                    messageIds: [pagedMessage.id],
                    runId: "run-paged-reviewed",
                    startedAt: 0,
                },
            ],
        });
        expect(
            store.elements().find((element) => element.id === "tool:paged-reviewed-call"),
        ).toMatchObject({
            permissionReview: {
                decision: "allow",
                toolCallId: "paged-reviewed-call",
            },
        });
    });

    it("atomically hands authoritative timing to a queued turn and records both wall clocks", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const first = event("message_submitted", {
            delivery: "run",
            displayText: "First",
            message: {
                blocks: [{ text: "First", type: "text" }],
                id: "user-1",
                role: "user",
            },
            runId: "run-1",
        });
        const second = event("message_submitted", {
            delivery: "run",
            displayText: "Second",
            message: {
                blocks: [{ text: "Second", type: "text" }],
                id: "user-2",
                role: "user",
            },
            runId: "run-2",
        });
        store.apply(first);
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(second);

        expect(store.session()).toMatchObject({
            activeTurn: { startedAt: first.createdAt, turnId: "run-1" },
        });

        const finished = event("run_finished", {
            modelLocked: false,
            runId: "run-1",
            stopReason: "stop",
        });
        const deltas = store.apply(finished);

        expect(store.session()).toMatchObject({
            activeTurn: { startedAt: second.createdAt, turnId: "run-2" },
        });
        expect(deltas).not.toContainEqual(
            expect.objectContaining({
                session: expect.not.objectContaining({ activeTurn: expect.anything() }),
                type: "session_changed",
            }),
        );
        expect(store.elements().find((element) => element.id === "turn:run-1")).toMatchObject({
            elapsedMs: finished.createdAt - first.createdAt,
            endedAt: finished.createdAt,
            kind: "turn_end",
            startedAt: first.createdAt,
        });
    });

    it("ends a failed turn with an error outcome that carries the reason", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(event("run_error", { errorMessage: "The provider failed.", runId: "run-1" }));

        expect(store.elements().at(-1)).toMatchObject({
            errorMessage: "The provider failed.",
            kind: "turn_end",
            outcome: "error",
        });
    });

    it("closes a tool call left open when a turn is stopped", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Bash", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        store.apply(event("run_finished", { runId: "run-1", stopReason: "aborted" }));

        const call = store.elements().find((element) => element.kind === "tool_call");
        expect(call).toMatchObject({ status: "interrupted" });
        expect(store.elements().at(-1)).toMatchObject({ kind: "turn_end", outcome: "stopped" });
    });

    it("grows text by delta instead of appending a second element", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ contentIndex: 0, delta: "Hel", messageId: "m1", type: "text_delta" }),
        );
        store.apply(
            agentEvent({ contentIndex: 0, delta: "lo", messageId: "m1", type: "text_delta" }),
        );

        const texts = store.elements().filter((element) => element.kind === "agent_text");
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatchObject({ complete: false, text: "Hello" });
    });

    it("keeps the identity of elements that did not change", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ contentIndex: 0, delta: "One", messageId: "m1", type: "text_delta" }),
        );
        store.apply(
            agentEvent({ content: "One", contentIndex: 0, messageId: "m1", type: "text_end" }),
        );
        const firstText = store.elements()[0] as ChatElement;

        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Bash", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );

        expect(store.elements()[0]).toBe(firstText);
    });

    it("gives a changed element a new reference so a consumer can tell it apart", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        const before = store.elements()[0];

        store.apply(
            agentEvent({ contentIndex: 0, delta: "Hi", messageId: "m1", type: "text_delta" }),
        );

        expect(store.elements()[0]).not.toBe(before);
    });

    it("lands a tool result on the element that was already there", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        const calls = store.elements().filter((element) => element.kind === "tool_call");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ result: "3 files", status: "succeeded" });
    });

    it("reports a tool failure as a failed call rather than a separate element", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Bash", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        store.apply(
            agentEvent({
                result: {
                    display: "No such file",
                    failure: { kind: "execution_failed" },
                    isError: true,
                    toolCallId: "call-1",
                    toolName: "Bash",
                },
                type: "tool_execution_end",
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            status: "failed",
        });
    });

    it("presents a command as one value that gains its output", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: {},
                    id: "call-1",
                    name: "Bash",
                    presentation: { command: "ls -la", type: "exec_command" },
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        );

        // While it runs, the command is known and the output is not.
        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: { command: "ls -la", kind: "command" },
        });
        expect(
            (
                store.elements().find((element) => element.kind === "tool_call") as {
                    presentation?: { output?: string };
                }
            ).presentation?.output,
        ).toBeUndefined();

        store.apply(
            agentEvent({
                result: {
                    display: "done",
                    presentation: { command: "ls -la", output: "3 files", type: "exec_command" },
                    toolCallId: "call-1",
                    toolName: "Bash",
                },
                type: "tool_execution_end",
            }),
        );

        // The same kind, now with output: a UI does not swap one shape for
        // another halfway through.
        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: { command: "ls -la", kind: "command", output: "3 files" },
        });
    });

    it("presents exploration as steps a UI can render without decoding the wire", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: {},
                    id: "call-1",
                    name: "Grep",
                    presentation: {
                        operations: [
                            { kind: "list", target: "sources" },
                            { kind: "read", name: "ChatStore.ts" },
                            { command: "rg todo", kind: "search", path: "sources", query: "todo" },
                        ],
                        type: "exploration",
                    },
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: {
                kind: "exploration",
                steps: [
                    { kind: "list", target: "sources" },
                    { kind: "read", name: "ChatStore.ts" },
                    { command: "rg todo", kind: "search", path: "sources", query: "todo" },
                ],
            },
        });
    });

    it("presents a file edit as the diff it is", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Edit", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        store.apply(
            agentEvent({
                result: {
                    display: "edited",
                    presentation: {
                        files: [{ hunks: [], kind: "update", path: "a.ts" }],
                        omittedFiles: 2,
                        type: "file_diff",
                    },
                    toolCallId: "call-1",
                    toolName: "Edit",
                },
                type: "tool_execution_end",
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: {
                files: [{ kind: "update", path: "a.ts" }],
                kind: "file_edit",
                omittedFiles: 2,
            },
        });
    });

    it("leaves a call unpresented when Rig described it in a way this library does not know", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: {},
                    id: "call-1",
                    name: "Future",
                    presentation: { type: "something_new" } as never,
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        );

        // A newer daemon must not break an older client: the plain result text
        // stays the fallback rather than a half-understood shape leaking out.
        const element = store.elements().find((item) => item.kind === "tool_call") as {
            presentation?: unknown;
        };
        expect(element.presentation).toBeUndefined();
    });

    it("groups tool calls issued together and leaves a lone call ungrouped", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        for (const id of ["call-1", "call-2"]) {
            store.apply(
                agentEvent({
                    toolCall: { arguments: {}, id, name: "Read", type: "tool_call" },
                    type: "tool_execution_start",
                }),
            );
        }

        const grouped = store
            .elements()
            .filter((e): e is ToolCallElement => e.kind === "tool_call");
        expect(grouped).toHaveLength(2);
        expect(grouped[0]?.groupId).toBeDefined();
        expect(grouped[0]?.groupId).toBe(grouped[1]?.groupId);

        const single = new ChatStore("session-2");
        single.applyHello(hello());
        single.apply(event("run_started", { runId: "run-1" }));
        single.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "only", name: "Read", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        expect(
            (single.elements().find((e) => e.kind === "tool_call") as ToolCallElement).groupId,
        ).toBeUndefined();
    });

    it("shows compaction as an element that reflects its current state", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                compactionId: "c1",
                estimatedTokensBefore: 120_000,
                reason: "threshold",
                type: "context_compaction_started",
            }),
        );

        expect(store.elements().find((element) => element.kind === "compaction")).toMatchObject({
            estimatedTokensBefore: 120_000,
            status: "running",
        });

        store.apply(
            agentEvent({
                compactedMessageCount: 12,
                compactionId: "c1",
                estimatedTokensAfter: 40_000,
                estimatedTokensBefore: 120_000,
                type: "context_compacted",
            }),
        );
        store.apply(
            agentEvent({
                compactionId: "c1",
                elapsedMs: 900,
                status: "completed",
                type: "context_compaction_finished",
            }),
        );

        expect(store.elements().find((element) => element.kind === "compaction")).toMatchObject({
            estimatedTokensAfter: 40_000,
            messagesCompacted: 12,
            status: "completed",
        });
    });

    it("emits ordered deltas for the turn, compaction, and retry lifecycle", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const deltas = runOneTurn(store);

        const kinds = deltas.map((delta) => delta.type);
        expect(kinds.indexOf("turn_started")).toBeLessThan(kinds.indexOf("turn_ended"));
        expect(deltas.at(-1)?.type).toBe("elements_changed");
    });

    it("retains a retry as a transcript element and reports its live lifecycle", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        const started = store.apply(
            event("inference_retry", {
                attempt: 2,
                reason: "rate limited",
                runId: "run-1",
            }),
        );
        expect(started.map((delta) => delta.type)).toContain("retry_started");
        expect(store.elements().at(-1)).toMatchObject({
            attempt: 2,
            kind: "retry",
            reason: "rate limited",
            turnId: "run-1",
        });

        store.apply(
            event("session_activity_changed", {
                activity: {
                    kind: "retrying",
                    label: "Retrying: rate limited",
                    retry: { attempt: 2, reason: "rate limited" },
                    since: 1,
                },
            }),
        );

        const finished = store.apply(
            event("session_activity_changed", {
                activity: { kind: "thinking", label: "Thinking", since: 2 },
            }),
        );
        expect(finished.map((delta) => delta.type)).toContain("retry_finished");
    });

    it("renders the message a run is part-way through when a client attaches mid-turn", () => {
        const store = new ChatStore("session-1");
        store.applyHello(
            hello({
                activity: { kind: "generating_message", label: "Writing a reply", since: 5 },
                partial: {
                    message: {
                        blocks: [{ text: "Half a th", type: "text" }],
                        id: "m1",
                        role: "agent",
                    },
                    runId: "run-1",
                },
            }),
        );

        expect(store.elements().filter((element) => element.kind === "agent_text")).toMatchObject([
            { complete: false, text: "Half a th" },
        ]);
    });

    it("converges on the same list whether text arrived as deltas or as a whole message", () => {
        const streamed = new ChatStore("session-1");
        streamed.applyHello(hello());
        streamed.apply(event("run_started", { runId: "run-1" }));
        streamed.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        streamed.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        streamed.apply(
            agentEvent({ contentIndex: 0, delta: "Done.", messageId: "m1", type: "text_delta" }),
        );
        streamed.apply(
            event("agent_message", {
                message: { blocks: [{ text: "Done.", type: "text" }], id: "m1", role: "agent" },
                runId: "run-1",
            }),
        );

        const texts = streamed.elements().filter((element) => element.kind === "agent_text");
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatchObject({ complete: true, text: "Done." });
    });

    it("reconciles streamed text by its absolute block position", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 1, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({
                contentIndex: 1,
                delta: "One visible update.",
                messageId: "m1",
                type: "text_delta",
            }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [
                        { thinking: "Internal reasoning.", type: "thinking" },
                        { text: "One visible update.", type: "text" },
                    ],
                    id: "m1",
                    role: "agent",
                },
                runId: "run-1",
            }),
        );

        expect(store.elements().filter((element) => element.kind === "agent_text")).toMatchObject([
            { complete: true, text: "One visible update." },
        ]);
    });

    it("discards tentative text when the provider restarts the message", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "Tentative",
                messageId: "m1",
                type: "text_delta",
            }),
        );
        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(1);

        store.apply(agentEvent({ messageId: "m1", partial: {}, type: "block_reset" }));

        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(0);
    });

    it("does not duplicate a message that is replayed after a reconnect", () => {
        const store = new ChatStore("session-1");
        store.applyHello({
            ...hello(),
            usage: {
                currentProviderId: "claude",
                groups: [],
                observedQuota: [],
                quotas: [],
                sessionTokenCount: { lastContextTokens: 0, totalTokens: 0 },
            },
        });
        store.apply(event("run_started", { runId: "run-1" }));
        const message = event("agent_message", {
            message: {
                blocks: [{ text: "Once.", type: "text" }],
                id: "m1",
                providerId: "claude",
                requestedModelId: "sonnet-5",
                role: "agent",
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
                    input: 10,
                    output: 2,
                    totalTokens: 12,
                },
            },
            runId: "run-1",
        });
        store.apply(message);
        store.apply(message);

        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(1);
        expect(store.session().usage?.totalTokens).toBe(12);
    });

    it("restores a running tool from current activity", () => {
        const store = new ChatStore("session-1");
        const toolMessage = {
            blocks: [
                {
                    arguments: { command: "pnpm test" },
                    id: "tool-1",
                    name: "Bash",
                    type: "tool_call" as const,
                },
            ],
            id: "agent-tool",
            role: "agent" as const,
        };

        store.applyHello(
            hello({
                activity: {
                    kind: "executing_tool_call",
                    label: "Running Bash",
                    since: 5,
                    toolCalls: [
                        {
                            startedAt: 5,
                            status: "Running tests",
                            toolCallId: "tool-1",
                            toolName: "Bash",
                        },
                    ],
                },
                session: {
                    ...hello().session!,
                    snapshot: { messages: [toolMessage] },
                },
                transcript: {
                    complete: true,
                    messages: [toolMessage],
                    turns: [
                        {
                            messageIds: ["agent-tool"],
                            runId: "run-1",
                            startedAt: 1,
                        },
                    ],
                },
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            progress: "Running tests",
            status: "running",
            toolCallId: "tool-1",
        });
    });

    it("rebuilds interleaved turns in their global message order", () => {
        const store = new ChatStore("session-1");
        const messages = [
            { blocks: [{ text: "u1", type: "text" as const }], id: "u1", role: "user" as const },
            { blocks: [{ text: "u2", type: "text" as const }], id: "u2", role: "user" as const },
            { blocks: [{ text: "a1", type: "text" as const }], id: "a1", role: "agent" as const },
            { blocks: [{ text: "a2", type: "text" as const }], id: "a2", role: "agent" as const },
        ];
        store.applyHello(
            hello({
                session: { ...hello().session!, snapshot: { messages } },
                transcript: {
                    complete: true,
                    messageCreatedAt: { a1: 3, a2: 5, u1: 1, u2: 2 },
                    messages,
                    turns: [
                        {
                            endedAt: 4,
                            messageIds: ["u1", "a1"],
                            outcome: "success",
                            runId: "run-1",
                            startedAt: 1,
                        },
                        {
                            endedAt: 6,
                            messageIds: ["u2", "a2"],
                            outcome: "success",
                            runId: "run-2",
                            startedAt: 2,
                        },
                    ],
                },
            }),
        );

        expect(
            store
                .elements()
                .filter(
                    (element) =>
                        element.kind === "user_message" ||
                        element.kind === "agent_text" ||
                        element.kind === "turn_end",
                )
                .map((element) => `${element.kind}:${element.turnId}`),
        ).toEqual([
            "user_message:run-1",
            "user_message:run-2",
            "agent_text:run-1",
            "turn_end:run-1",
            "agent_text:run-2",
            "turn_end:run-2",
        ]);
    });

    it("keeps the transcript untouched when a resume carries no session", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);
        const before = store.elements();

        store.applyHello({
            activity: { kind: "idle", label: "Idle", since: 9 },
            resumed: true,
        });

        expect(store.elements()).toBe(before);
    });

    it("renders a non-internal system message as a system notice", () => {
        const store = new ChatStore("session-1");
        const opening = hello();
        store.applyHello({
            ...opening,
            session: {
                ...opening.session!,
                snapshot: {
                    messages: [
                        {
                            blocks: [{ text: "The environment restarted.", type: "text" }],
                            id: "system-1",
                            role: "system",
                        },
                    ],
                },
            },
        });

        expect(store.elements()).toMatchObject([
            {
                kind: "system_notice",
                text: "The environment restarted.",
            },
        ]);
    });

    it("tracks live session facts without a follow-up request", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        store.apply(event("session_configuration_changed", { modelId: "opus-5" }));
        store.apply(
            event("session_git_changed", {
                git: { branch: "main", changedFiles: 3, files: [] },
            }),
        );
        store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));
        store.apply(
            event("session_context_changed", {
                sessionTokenCount: { lastContextTokens: 42_000, totalTokens: 90_000 },
            }),
        );

        expect(store.session()).toMatchObject({
            cwd: "/work",
            modelId: "opus-5",
            title: "Ship it",
            tokens: { lastContextTokens: 42_000, totalTokens: 90_000 },
        });
        expect(store.session().git).toMatchObject({ branch: "main", changedFiles: 3 });
    });

    it("reconciles non-replayable session facts from a resumed hello", () => {
        const store = new ChatStore("session-1");
        store.applyHello(
            hello({
                session: {
                    ...hello().session!,
                    draft: "stale",
                    git: {
                        branch: "stale",
                        changedFiles: 1,
                        comparison: "ready",
                        conflicted: false,
                        countsExact: true,
                        deletions: 0,
                        files: [],
                        filesTruncated: false,
                        generation: "old",
                        insertions: 1,
                        scannedAt: 1,
                        version: 1,
                    },
                    sessionTokenCount: { lastContextTokens: 1, totalTokens: 1 },
                },
            }),
        );

        store.applyHello({
            activity: { kind: "idle", label: "Idle", since: 2 },
            current: {
                draftUpdatedAt: 2,
                git: {
                    changedFiles: 2,
                    comparison: "ready",
                    conflicted: false,
                    countsExact: true,
                    deletions: 1,
                    facts: {
                        ahead: 0,
                        behind: 0,
                        branch: "main",
                        detached: false,
                    },
                    files: [],
                    filesTruncated: false,
                    generation: "new",
                    insertions: 2,
                    scannedAt: 2,
                    version: 2,
                },
                sessionTokenCount: { lastContextTokens: 42, totalTokens: 90 },
            },
            resumed: true,
        });

        expect(store.session()).toMatchObject({
            draftUpdatedAt: 2,
            git: { branch: "main", changedFiles: 2 },
            tokens: { lastContextTokens: 42, totalTokens: 90 },
        });
        expect(store.session().draft).toBeUndefined();
    });

    it("ignores an event it does not recognise", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const before = store.elements();

        expect(store.apply(event("something_new", { whatever: true }))).toEqual([]);
        expect(store.elements()).toBe(before);
    });

    describe("live session facts", () => {
        it("initializes the complete application state from the opening frame", () => {
            const store = new ChatStore("session-1");
            const opening = hello();
            store.applyHello({
                ...opening,
                session: {
                    ...opening.session!,
                    archived: true,
                    backgroundProcesses: [
                        {
                            command: "pnpm test",
                            cwd: "/work",
                            sessionId: 7,
                            status: "running",
                        },
                    ],
                    draft: "Keep this",
                    draftUpdatedAt: 11,
                    effort: "high",
                    goal: {
                        createdAt: 1,
                        objective: "Ship it",
                        status: "active",
                        updatedAt: 2,
                    },
                    modelLocked: true,
                    models: [
                        {
                            defaultThinkingLevel: "medium",
                            id: "sonnet-5",
                            name: "Sonnet 5",
                            thinkingLevels: ["low", "medium", "high"],
                        },
                    ],
                    orderKey: "b0",
                    pendingSteeringMessages: [
                        {
                            createdAt: 10,
                            message: {
                                blocks: [{ text: "Also check this", type: "text" }],
                                id: "steer-1",
                                role: "user",
                            },
                            runId: "run-1",
                        },
                    ],
                    pendingUserInputs: [
                        {
                            questions: [
                                {
                                    header: "Choice",
                                    id: "choice",
                                    multiSelect: false,
                                    options: [{ description: "Use it", label: "Yes" }],
                                    question: "Proceed?",
                                },
                            ],
                            requestId: "input-1",
                        },
                    ],
                    permissionMode: "read_only",
                    projectId: "project-1",
                    recap: "Ready to ship",
                    serviceTier: "priority",
                    subagents: [
                        {
                            agentId: "agent-2",
                            createdAt: 1,
                            depth: 1,
                            description: "Review",
                            id: "session-2",
                            modelId: "sonnet-5",
                            parentSessionId: "session-1",
                            status: "idle",
                            updatedAt: 2,
                        },
                    ],
                    tasks: [
                        {
                            blockedBy: [],
                            blocks: [],
                            description: "Run tests",
                            id: "task-1",
                            status: "in_progress",
                            subject: "Verify",
                        },
                    ],
                    workspaceId: "workspace-1",
                },
            });

            expect(store.session()).toMatchObject({
                archived: true,
                backgroundProcesses: [{ sessionId: 7 }],
                draft: "Keep this",
                draftUpdatedAt: 11,
                effort: "high",
                goal: { objective: "Ship it" },
                modelLocked: true,
                models: [{ id: "sonnet-5" }],
                orderKey: "b0",
                pendingSteeringMessages: [{ runId: "run-1" }],
                pendingUserInputs: [{ requestId: "input-1" }],
                permissionMode: "read_only",
                projectId: "project-1",
                recap: "Ready to ship",
                serviceTier: "priority",
                subagents: [{ id: "session-2" }],
                tasks: [{ id: "task-1" }],
                workspaceId: "workspace-1",
            });
        });

        it("keeps application state current from complete live events", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(
                event("session_draft_changed", {
                    draft: "Draft",
                    origin: "happy",
                    updatedAt: 10,
                }),
            );
            store.apply(
                event("user_input_requested", {
                    questions: [],
                    requestId: "input-1",
                }),
            );
            store.apply(
                event("tasks_changed", {
                    tasks: [
                        {
                            blockedBy: [],
                            blocks: [],
                            description: "Run tests",
                            id: "task-1",
                            status: "pending",
                            subject: "Verify",
                        },
                    ],
                }),
            );
            store.apply(
                event("goal_changed", {
                    goal: {
                        createdAt: 1,
                        objective: "Ship",
                        status: "active",
                        updatedAt: 1,
                    },
                }),
            );
            store.apply(
                event("subagent_changed", {
                    subagent: {
                        agentId: "agent-2",
                        createdAt: 1,
                        depth: 1,
                        description: "Review",
                        id: "session-2",
                        modelId: "sonnet-5",
                        parentSessionId: "session-1",
                        status: "running",
                        updatedAt: 2,
                    },
                }),
            );
            store.apply(
                event("shell_command_started", {
                    command: "pnpm test",
                    commandId: "command-1",
                    sessionId: 8,
                }),
            );
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: "Check this",
                    message: {
                        blocks: [{ text: "Check this", type: "text" }],
                        id: "steer-1",
                        role: "user",
                    },
                    runId: "run-1",
                }),
            );
            store.apply(
                agentEvent({
                    processes: [
                        {
                            command: "pnpm dev",
                            cwd: "/work",
                            sessionId: 9,
                            status: "running",
                        },
                    ],
                    running: 1,
                    type: "background_processes_changed",
                }),
            );
            store.apply(
                agentEvent({
                    toolCall: {
                        arguments: { command: "pnpm test" },
                        id: "call-1",
                        name: "exec_command",
                        type: "tool_call",
                    },
                    type: "tool_execution_start",
                }),
            );
            store.apply(
                agentEvent({
                    action: "Run tests",
                    decision: "allow",
                    reason: "The user asked for verification.",
                    risk: "low",
                    toolCallId: "call-1",
                    type: "permission_review",
                    userAuthorization: "high",
                }),
            );

            expect(store.session()).toMatchObject({
                backgroundProcesses: [{ sessionId: 9 }],
                draft: "Draft",
                draftUpdatedAt: 10,
                goal: { objective: "Ship" },
                pendingSteeringMessages: [{ message: { id: "steer-1" } }],
                pendingUserInputs: [{ requestId: "input-1" }],
                permissionReviews: [
                    {
                        action: "Run tests",
                        decision: "allow",
                        reason: "The user asked for verification.",
                        risk: "low",
                        toolCallId: "call-1",
                        userAuthorization: "high",
                    },
                ],
                shellCommands: [{ commandId: "command-1", status: "running" }],
                subagents: [{ id: "session-2", status: "running" }],
                tasks: [{ id: "task-1" }],
            });
            expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
                permissionReview: {
                    action: "Run tests",
                    decision: "allow",
                    reason: "The user asked for verification.",
                    risk: "low",
                    userAuthorization: "high",
                },
            });

            store.apply(
                event("shell_command_finished", {
                    command: "pnpm test",
                    commandId: "command-1",
                    exitCode: 0,
                    output: "passed",
                    sessionId: 8,
                    timedOut: false,
                }),
            );
            store.apply(event("steering_applied", { messageIds: ["steer-1"], runId: "run-1" }));
            store.apply(
                event("user_input_resolved", {
                    requestId: "input-1",
                    status: "cancelled",
                }),
            );
            store.apply(event("goal_changed", { goal: null }));

            expect(store.session().shellCommands).toMatchObject([
                { commandId: "command-1", status: "finished" },
            ]);
            expect(store.session().pendingSteeringMessages).toEqual([]);
            expect(store.session().pendingUserInputs).toEqual([]);
            expect(store.session().goal).toBeUndefined();
        });

        it("preserves a title while metadata is generating or reports an error", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));

            store.apply(event("session_title_changed", { status: "generating" }));
            expect(store.session().title).toBe("Ship it");

            store.apply(
                event("session_title_changed", {
                    errorMessage: "Could not refresh metadata.",
                    status: "error",
                }),
            );
            expect(store.session().title).toBe("Ship it");
        });

        it("removes a title when the daemon settles without one", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));

            store.apply(event("session_title_changed", { status: "idle" }));

            expect(store.session().title).toBeUndefined();
        });

        it("tracks effort, service tier, and permission mode", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    effort: "high",
                    modelId: "opus-5",
                    serviceTier: "priority",
                }),
            );
            store.apply(event("permission_mode_changed", { permissionMode: "read_only" }));

            expect(store.session()).toMatchObject({
                effort: "high",
                modelId: "opus-5",
                permissionMode: "read_only",
                serviceTier: "priority",
            });
        });

        it("clears effort and service tier when the session no longer has them", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    effort: "high",
                    modelId: "opus-5",
                    serviceTier: "priority",
                }),
            );

            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    modelId: "sonnet-5",
                    serviceTier: null,
                }),
            );

            expect(store.session().effort).toBeUndefined();
            expect(store.session().serviceTier).toBeUndefined();
        });
    });

    describe("what a turn cost", () => {
        function usage(input: number, output: number, cost: number) {
            return {
                cacheRead: 0,
                cacheWrite: 0,
                cost: { cacheRead: 0, cacheWrite: 0, input: cost, output: 0, total: cost },
                input,
                output,
                totalTokens: input + output,
            };
        }

        it("opens with complete session usage and derives panel totals", () => {
            const store = new ChatStore("session-1");
            store.applyHello({
                ...hello(),
                usage: {
                    currentProviderId: "claude",
                    groups: [
                        {
                            kind: "attributed",
                            modelId: "sonnet-5",
                            providerId: "claude",
                            requestedModelId: "sonnet-5",
                            usage: usage(100, 20, 0.5),
                        },
                    ],
                    observedQuota: [],
                    quotas: [],
                    sessionTokenCount: { lastContextTokens: 120, totalTokens: 120 },
                },
            });

            expect(store.session().usage).toMatchObject({
                currentProviderId: "claude",
                totalCost: 0.5,
                totalTokens: 120,
            });
        });

        it("keeps session usage, context, and provider quota current from stream events", () => {
            const store = new ChatStore("session-1");
            store.applyHello({
                ...hello(),
                usage: {
                    currentProviderId: "claude",
                    groups: [],
                    observedQuota: [],
                    quotas: [],
                    sessionTokenCount: { lastContextTokens: 0, totalTokens: 0 },
                },
            });
            store.apply(event("run_started", { runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "Done", type: "text" }],
                        id: "m-usage",
                        providerId: "claude",
                        requestedModelId: "sonnet-5",
                        role: "agent",
                        usage: usage(200, 30, 0.75),
                    },
                    runId: "run-1",
                }),
            );
            store.apply(
                event("provider_quota_observed", {
                    observationId: "quota-1",
                    phase: "before",
                    providerId: "claude",
                    quota: {
                        capturedAt: 9,
                        source: "claude",
                        windows: {
                            fiveHour: {
                                capturedAt: 9,
                                resetsAt: 20,
                                status: "available",
                                usedPercent: 20,
                            },
                        },
                    },
                    runId: "run-1",
                }),
            );
            store.apply(
                event("provider_quota_observed", {
                    observationId: "quota-1",
                    phase: "after",
                    providerId: "claude",
                    quota: {
                        capturedAt: 10,
                        source: "claude",
                        windows: {
                            fiveHour: {
                                capturedAt: 10,
                                resetsAt: 20,
                                status: "available",
                                usedPercent: 25,
                            },
                        },
                    },
                    runId: "run-1",
                }),
            );
            store.apply(
                event("session_quota_contribution_changed", {
                    observedQuota: [
                        {
                            providerId: "claude",
                            windows: { fiveHour: { observedUsedPercent: 5 } },
                        },
                    ],
                }),
            );

            expect(store.session().usage).toMatchObject({
                context: { approximate: false, totalTokens: 230 },
                currentProviderId: "claude",
                observedQuota: [
                    {
                        providerId: "claude",
                        windows: { fiveHour: { observedUsedPercent: 5 } },
                    },
                ],
                quotas: [{ providerId: "claude", quota: { capturedAt: 10 } }],
                totalCost: 0.75,
                totalTokens: 230,
            });
        });

        it("clears context attribution immediately when the model changes", () => {
            const store = new ChatStore("session-1");
            store.applyHello({
                ...hello(),
                usage: {
                    context: {
                        approximate: false,
                        modelId: "sonnet-5",
                        providerId: "claude",
                        requestedModelId: "sonnet-5",
                        totalTokens: 100,
                    },
                    currentProviderId: "claude",
                    groups: [],
                    observedQuota: [],
                    quotas: [],
                    sessionTokenCount: { lastContextTokens: 100, totalTokens: 100 },
                },
            });

            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    modelId: "opus-5",
                    providerId: "claude",
                    serviceTier: null,
                }),
            );

            expect(store.session().usage?.context).toBeUndefined();
        });

        it("reports the usage of the turn on the element that ends it", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(event("run_started", { runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "Done", type: "text" }],
                        id: "m1",
                        role: "agent",
                        usage: usage(100, 20, 0.5),
                    },
                    runId: "run-1",
                }),
            );
            store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

            const end = store.elements().at(-1);
            expect(end?.kind).toBe("turn_end");
            expect(end).toMatchObject({
                usage: { input: 100, output: 20, totalTokens: 120 },
            });
        });

        it("adds up every inference the turn needed, not just the last", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            // A turn that calls tools runs inference more than once, and the cost
            // of the turn is all of it.
            store.apply(event("run_started", { runId: "run-1" }));
            for (const [index, tokens] of [100, 250].entries()) {
                store.apply(
                    event("agent_message", {
                        message: {
                            blocks: [{ text: `Step ${index}`, type: "text" }],
                            id: `m${index}`,
                            role: "agent",
                            usage: usage(tokens, 10, 0.25),
                        },
                        runId: "run-1",
                    }),
                );
            }
            store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

            expect(store.elements().at(-1)).toMatchObject({
                usage: {
                    cost: { total: 0.5 },
                    input: 350,
                    output: 20,
                    totalTokens: 370,
                },
            });
        });

        it("leaves the cost off a turn the daemon never reported one for", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            runOneTurn(store);

            const end = store.elements().at(-1);
            expect(end?.kind).toBe("turn_end");
            // Reporting zero would claim the turn was free, which is a different
            // statement from not knowing.
            expect((end as { usage?: unknown }).usage).toBeUndefined();
        });

        it("does not carry one turn's cost into the next", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(event("run_started", { runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "First", type: "text" }],
                        id: "m1",
                        role: "agent",
                        usage: usage(100, 20, 0.5),
                    },
                    runId: "run-1",
                }),
            );
            store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

            store.apply(event("run_started", { runId: "run-2" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "Second", type: "text" }],
                        id: "m2",
                        role: "agent",
                        usage: usage(7, 3, 0.1),
                    },
                    runId: "run-2",
                }),
            );
            store.apply(event("run_finished", { runId: "run-2", stopReason: "stop" }));

            const ends = store.elements().filter((element) => element.kind === "turn_end");
            expect(ends).toHaveLength(2);
            expect(ends[1]).toMatchObject({ usage: { input: 7, output: 3, totalTokens: 10 } });
        });
    });

    describe("history rebuilt from reported turns", () => {
        const messages = [
            { blocks: [{ text: "First ask", type: "text" }], id: "u1", role: "user" },
            { blocks: [{ text: "First answer", type: "text" }], id: "a1", role: "agent" },
            { blocks: [{ text: "Second ask", type: "text" }], id: "u2", role: "user" },
            { blocks: [{ text: "Second answer", type: "text" }], id: "a2", role: "agent" },
        ] as const;

        function withTurns(overrides: Partial<SessionStreamHello> = {}): SessionStreamHello {
            const base = hello();
            return {
                ...base,
                session: { ...base.session!, snapshot: { messages: [...messages] } },
                transcript: {
                    complete: true,
                    messages: [...messages],
                    turns: [
                        {
                            endedAt: 1_500,
                            messageIds: ["u1", "a1"],
                            outcome: "success",
                            runId: "run-1",
                            startedAt: 1_000,
                        },
                        {
                            endedAt: 2_800,
                            errorMessage: "It broke",
                            messageIds: ["u2", "a2"],
                            outcome: "error",
                            runId: "run-2",
                            startedAt: 2_000,
                        },
                    ],
                },
                ...overrides,
            };
        }

        it("closes every historical turn, as the live path does", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            // The advertised guarantee is that a turn always ends with a final
            // element. History that was never watched live must honour it too.
            expect(store.elements().map((element) => element.kind)).toEqual([
                "user_message",
                "agent_text",
                "turn_end",
                "user_message",
                "agent_text",
                "turn_end",
            ]);
        });

        it("attributes historical elements to the run they belong to", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            expect(store.elements().map((element) => element.turnId)).toEqual([
                "run-1",
                "run-1",
                "run-1",
                "run-2",
                "run-2",
                "run-2",
            ]);
        });

        it("keeps each historical message's own occurrence time", () => {
            const store = new ChatStore("session-1");
            const opening = withTurns();
            store.applyHello({
                ...opening,
                transcript: {
                    ...opening.transcript!,
                    messageCreatedAt: {
                        a1: 1_400,
                        a2: 2_700,
                        u1: 1_050,
                        u2: 2_100,
                    },
                },
            });

            const messages = store
                .elements()
                .filter(
                    (element) => element.kind === "user_message" || element.kind === "agent_text",
                );
            expect(messages.map((element) => element.createdAt)).toEqual([
                1_050, 1_400, 2_100, 2_700,
            ]);
        });

        it("reports the real outcome and duration of a historical turn", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            const ends = store.elements().filter((element) => element.kind === "turn_end");
            expect(ends[0]).toMatchObject({
                elapsedMs: 500,
                endedAt: 1_500,
                outcome: "success",
                startedAt: 1_000,
            });
            expect(ends[1]).toMatchObject({
                endedAt: 2_800,
                errorMessage: "It broke",
                outcome: "error",
                startedAt: 2_000,
            });
        });

        it("rebuilds durable retries in their historical time position", () => {
            const store = new ChatStore("session-1");
            const opening = withTurns();
            store.applyHello({
                ...opening,
                transcript: {
                    ...opening.transcript!,
                    messageCreatedAt: { a1: 1_200, a2: 2_700, u1: 1_050, u2: 2_100 },
                    messageEventId: {
                        a1: "018bcfe5-6800-7002-8000-00000000aaaa",
                    },
                    turns: [
                        {
                            ...opening.transcript!.turns[0]!,
                            retries: [
                                {
                                    attempt: 1,
                                    createdAt: 1_200,
                                    id: "018bcfe5-6800-7001-8000-00000000aaaa",
                                    reason: "Connection lost",
                                },
                            ],
                        },
                        opening.transcript!.turns[1]!,
                    ],
                },
            });

            expect(
                store.elements().map((element) => [element.kind, element.createdAt]),
            ).toContainEqual(["retry", 1_200]);
            expect(store.elements().findIndex((element) => element.kind === "retry")).toBe(
                store.elements().findIndex((element) => element.id === "a1:agent_text:0") - 1,
            );
        });

        it("leaves a turn that is still running open for live events to finish", () => {
            const store = new ChatStore("session-1");
            const base = withTurns();
            store.applyHello({
                ...base,
                transcript: {
                    ...base.transcript!,
                    turns: [
                        base.transcript!.turns[0]!,
                        { messageIds: ["u2", "a2"], runId: "run-2", startedAt: 2_000 },
                    ],
                },
            });

            const kinds = store.elements().map((element) => element.kind);
            expect(kinds.filter((kind) => kind === "turn_end")).toHaveLength(1);
            expect(kinds.at(-1)).toBe("agent_text");
            expect(store.session().activeTurn).toEqual({
                startedAt: 2_000,
                turnId: "run-2",
            });

            store.apply(
                event("session_activity_changed", {
                    activity: { kind: "tool", label: "Running a tool", since: 90_000 },
                }),
            );
            expect(store.session().activeTurn).toEqual({
                startedAt: 2_000,
                turnId: "run-2",
            });
        });

        it("reports what a historical turn cost, as the live path does", () => {
            const store = new ChatStore("session-1");
            const base = withTurns();
            const priced = [
                base.transcript!.messages[0]!,
                {
                    ...(base.transcript!.messages[1] as object),
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 0, total: 0.3 },
                        input: 90,
                        output: 10,
                        totalTokens: 100,
                    },
                },
                base.transcript!.messages[2]!,
                base.transcript!.messages[3]!,
            ] as NonNullable<typeof base.transcript>["messages"];

            store.applyHello({
                ...base,
                session: { ...base.session!, snapshot: { messages: [...priced] } },
                transcript: { ...base.transcript!, messages: priced },
            });

            const ends = store.elements().filter((element) => element.kind === "turn_end");
            expect(ends[0]).toMatchObject({ usage: { input: 90, totalTokens: 100 } });
            // The second turn was never priced, so it must not inherit the first.
            expect((ends[1] as { usage?: unknown }).usage).toBeUndefined();
        });

        it("tells the caller when older turns exist beyond the window", () => {
            const store = new ChatStore("session-1");
            const base = withTurns();
            store.applyHello({
                ...base,
                transcript: { ...base.transcript!, complete: false },
            });

            expect(store.session().transcriptComplete).toBe(false);
        });

        it("treats a transcript with no reported turns as complete", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            expect(store.session().transcriptComplete).toBe(true);
        });
    });

    it("does not retain positions for elements a rewind discarded", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        store.apply(
            event("session_rewound", {
                messageId: "m1",
                snapshot: {
                    messages: [
                        { blocks: [{ text: "Start over", type: "text" }], id: "u1", role: "user" },
                    ],
                },
            }),
        );
        store.apply(event("run_started", { runId: "run-2" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m2", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m2", type: "text_start" }));
        store.apply(
            agentEvent({ contentIndex: 0, delta: "Again", messageId: "m2", type: "text_delta" }),
        );

        // A rewind replaces the whole list, so the positions it tracked are
        // dead. Without clearing them the index grows on every rewind while the
        // conversation does not.
        expect(store.elements()).toMatchObject([
            { kind: "user_message", text: "Start over" },
            { complete: false, kind: "agent_text", text: "Again" },
        ]);
    });

    it("rebuilds the list when a session is rewound", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        store.apply(
            event("session_rewound", {
                messageId: "m1",
                snapshot: {
                    messages: [
                        { blocks: [{ text: "Start over", type: "text" }], id: "u1", role: "user" },
                    ],
                },
            }),
        );

        expect(store.elements()).toMatchObject([{ kind: "user_message", text: "Start over" }]);
    });

    it("rebuilds authoritative active timing when the session is reset", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const message = {
            blocks: [{ text: "Continue", type: "text" as const }],
            id: "u-reset",
            role: "user" as const,
        };
        store.apply(
            event("session_reset", {
                snapshot: { messages: [message] },
                transcript: {
                    complete: true,
                    messages: [message],
                    turns: [
                        {
                            messageIds: [message.id],
                            runId: "run-reset",
                            startedAt: 5_000,
                        },
                    ],
                },
            }),
        );

        expect(store.session().activeTurn).toEqual({
            startedAt: 5_000,
            turnId: "run-reset",
        });
        const finished = event("run_finished", {
            modelLocked: false,
            runId: "run-reset",
            stopReason: "stop",
        });
        store.apply(finished);
        expect(store.elements().at(-1)).toMatchObject({
            endedAt: finished.createdAt,
            startedAt: 5_000,
        });
    });
});

describe("durable status", () => {
    it("takes the status from the opening frame", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello({ session: { ...hello().session!, status: "suspended" } }));

        // A session that is suspended has to read as suspended before anything
        // happens on the stream.
        expect(store.session().status).toBe("suspended");
    });

    it("follows the status without asking for the session again", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        const deltas = store.apply(event("session_status_changed", { status: "error" }));

        expect(store.session().status).toBe("error");
        expect(deltas).toContainEqual(expect.objectContaining({ type: "session_changed" }));
    });

    it("keeps the status apart from the activity", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("session_status_changed", { status: "running" }));

        store.apply(
            event("session_activity_changed", {
                activity: { kind: "idle", label: "Idle", since: 5 },
            }),
        );

        // Activity is the current moment and settles on its own. The durable
        // status is a lifecycle fact and must not be overwritten by it.
        expect(store.session().activity.kind).toBe("idle");
        expect(store.session().status).toBe("running");
    });

    it("reports a live fact that only lives on the session", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        const git = store.apply(event("session_git_changed", { git: { branch: "main" } }));
        const context = store.apply(
            event("session_context_changed", { sessionTokenCount: { total: 5 } }),
        );

        // These change nothing in the element list, so nothing else would tell a
        // subscriber they happened. A store that updated itself silently would
        // leave a branch name or a context meter stale on screen forever.
        expect(git.map((delta) => delta.type)).toEqual(["session_changed"]);
        expect(context.map((delta) => delta.type)).toEqual(["session_changed"]);
    });

    it("advances the authoritative cursor even when a visible value repeats", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("session_status_changed", { status: "running" }));

        const repeated = store.apply(event("session_status_changed", { status: "running" }));

        expect(repeated).toHaveLength(1);
        expect(repeated[0]).toMatchObject({
            session: { lastEventId: expect.any(String), status: "running" },
            type: "session_changed",
        });
    });

    it("follows archiving, which is its own flag", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        expect(store.session().archived).toBe(false);

        store.apply(event("session_archived", { archived: true }));

        expect(store.session().archived).toBe(true);
    });
});

describe("recovering a connection", () => {
    function message(id: string, role: "user" | "agent") {
        return { blocks: [{ text: id, type: "text" }], id, role } as never;
    }

    /** A window of whole turns, named `run-{first}` .. `run-{last}`. */
    function windowOf(first: number, last: number, complete: boolean) {
        const messages: Message[] = [];
        const turns = [];
        for (let index = first; index <= last; index += 1) {
            messages.push(message(`u${index}`, "user"), message(`a${index}`, "agent"));
            turns.push({
                endedAt: index * 100 + 50,
                messageIds: [`u${index}`, `a${index}`],
                outcome: "success" as const,
                runId: `run-${index}`,
                startedAt: index * 100,
            });
        }
        return { complete, messages, turns };
    }

    function helloWith(first: number, last: number, complete: boolean): SessionStreamHello {
        const base = hello();
        const transcript = windowOf(first, last, complete);
        return {
            ...base,
            session: { ...base.session!, snapshot: { messages: transcript.messages } },
            transcript,
        };
    }

    it("keeps the turns it already loaded when a recovery brings a newer window", () => {
        const store = new ChatStore("session-1");
        // A reader has scrolled back and loaded turns 1 through 6.
        store.applyHello(helloWith(1, 6, false));
        const before = store.elements();
        expect(before.length).toBeGreaterThan(0);

        // The cursor expired, so the stream reconnects from scratch and the
        // daemon answers with only the newest turns it bounds a hello to.
        store.applyHello(helloWith(4, 6, false));

        // Losing turns 1 through 3 here would delete rows off the top of a
        // conversation somebody is reading.
        const turnIds = store.elements().map((element) => element.turnId);
        expect(turnIds).toContain("run-1");
        expect(turnIds).toContain("run-6");
    });

    it("does not duplicate the turns that both windows describe", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        store.applyHello(helloWith(4, 6, false));

        const ids = store.elements().map((element) => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("keeps element identities across a recovery, so a reader holds their place", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));
        const before = store.elements().map((element) => element.id);

        store.applyHello(helloWith(4, 6, false));

        expect(store.elements().map((element) => element.id)).toEqual(before);
    });

    it("keeps the element a reader is positioned on, by reference", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));
        // A reader has scrolled up into the oldest page and is sitting on it.
        const anchor = store.elements().find((element) => element.id === "message:u2");
        expect(anchor).toBeDefined();

        store.applyHello(helloWith(4, 6, false));

        // A retained turn is not restated by the fresh window, so rebuilding its
        // rows into new objects would move a reader off their scroll anchor even
        // though the content is identical.
        expect(store.elements().find((element) => element.id === "message:u2")).toBe(anchor);
    });

    it("keeps real turns through a rewind", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        // The daemon rewound to turn 4, so turns 5 and 6 are gone.
        const remaining = windowOf(1, 4, true);
        store.apply(
            event("session_rewound", {
                messageId: "u5",
                snapshot: { messages: remaining.messages },
                transcript: remaining,
            }),
        );

        const turnIds = store.elements().map((element) => element.turnId);
        // Falling back to invented per-message turns here would lose the turn
        // guarantee: a rewound transcript would have no closing element and no
        // real run identity.
        expect(turnIds).not.toContain("run-5");
        expect(new Set(turnIds)).toEqual(new Set(["run-1", "run-2", "run-3", "run-4"]));
        expect(store.elements().filter((element) => element.kind === "turn_end")).toHaveLength(4);
    });

    it("keeps real turns through a reset", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        store.apply(
            event("session_reset", {
                snapshot: { messages: [] },
                transcript: { complete: true, messages: [], turns: [] },
            }),
        );

        // A reset clears the conversation, and the retained older turns must not
        // survive it.
        expect(store.elements()).toEqual([]);
    });

    it("adds earlier turns in front without disturbing the ones already loaded", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const anchor = store.elements().find((element) => element.id === "message:u4");
        const earlier = windowOf(1, 3, true);

        store.prependEarlier({
            ...earlier,
            messageCreatedAt: { a1: 140, u1: 110 },
        });

        const turnIds = store.elements().map((element) => element.turnId);
        expect(turnIds.indexOf("run-1")).toBeLessThan(turnIds.indexOf("run-4"));
        // A reader's scroll anchor is a row they are looking at. Rebuilding it
        // while adding history above would jump the viewport.
        expect(store.elements().find((element) => element.id === "message:u4")).toBe(anchor);
        expect(store.elements().find((element) => element.id === "message:u1")?.createdAt).toBe(
            110,
        );
        expect(store.session().transcriptComplete).toBe(true);
        expect(store.session().loadingMore).toBe(false);
    });

    it("does not erase live output or pending steering when an older page lands", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");
        const started = store.startLoadingMore(token);
        if (started === undefined) throw new Error("Expected loading to start.");

        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "Arrived while paging",
                messageId: "agent-live-during-page",
                type: "text_delta",
            }),
        );
        store.apply(
            event("message_submitted", {
                delivery: "steer",
                displayText: "Also do this",
                message: {
                    blocks: [{ text: "Also do this", type: "text" }],
                    id: "steer-during-page",
                    role: "user",
                },
                runId: "run-6",
            }),
        );
        store.prependEarlier(windowOf(1, 3, true), started.anchor);

        expect(store.elements().some((element) => element.id === "message:u1")).toBe(true);
        expect(
            store
                .elements()
                .some((element) => element.id === "agent-live-during-page:agent_text:0"),
        ).toBe(true);
        expect(store.elements().at(-1)).toMatchObject({
            delivery: "pending_steering",
            messageId: "steer-during-page",
        });
    });

    it.each(["session_reset", "session_rewound"] as const)(
        "does not resurrect turns when an earlier page arrives after %s",
        (type) => {
            const store = new ChatStore("session-1");
            store.applyHello(helloWith(4, 6, false));
            const token = store.session().loadMoreToken;
            if (token === undefined) throw new Error("Expected a load-more token.");
            const started = store.startLoadingMore(token);
            if (started === undefined) throw new Error("Expected loading to start.");

            store.apply(
                event(type, {
                    ...(type === "session_rewound" ? { messageId: "u4" } : {}),
                    snapshot: { messages: [] },
                    transcript: { complete: true, messages: [], turns: [] },
                }),
            );
            store.prependEarlier(windowOf(1, 3, true), started.anchor);

            expect(store.elements()).toEqual([]);
            expect(store.session().loadingMore).toBe(false);
            expect(store.session().transcriptComplete).toBe(true);
        },
    );

    it("knows which run to ask from, and stops asking at the beginning", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        expect(store.earliestRunId()).toBe("run-4");

        store.prependEarlier(windowOf(1, 3, true));

        // The conversation is fully loaded, so there is nothing left to ask for.
        expect(store.earliestRunId()).toBeUndefined();
    });

    it("consumes a message token once and clears a failure on the next try", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");

        const started = store.startLoadingMore(token);
        if (started === undefined) throw new Error("Expected loading to start.");
        expect(store.session().loadingMore).toBe(true);
        // A duplicate call from the same render is consumed synchronously.
        expect(store.startLoadingMore(token)).toBeUndefined();
        store.failLoadingMore(started.anchor, "Could not reach Rig.");
        expect(store.session().loadMoreError).toBe("Could not reach Rig.");
        expect(store.session().loadingMore).toBe(false);

        store.startLoadingMore(token);

        // A retry starts from a clean slate, so a stale message is not shown
        // next to a request that is currently in flight.
        expect(store.session().loadMoreError).toBeUndefined();
    });

    it("clears a stale load when the transcript is rebuilt before its request fails", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");
        const started = store.startLoadingMore(token);
        if (started === undefined) throw new Error("Expected loading to start.");

        store.apply(
            event("session_reset", {
                snapshot: { messages: [] },
                transcript: { complete: true, messages: [], turns: [] },
            }),
        );
        store.failLoadingMore(started.anchor, "Stale request failed.");

        expect(store.session().loadingMore).toBe(false);
    });

    it("clears a stale load immediately when a fresh hello replaces the transcript", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");
        expect(store.startLoadingMore(token)).toBeDefined();

        store.applyHello(helloWith(5, 7, false));

        expect(store.session().loadingMore).toBe(false);
        const replacement = store.session().loadMoreToken;
        if (replacement === undefined) throw new Error("Expected a replacement token.");
        expect(store.startLoadingMore(replacement)).toBeDefined();
    });

    it("trusts a complete window to be the whole conversation", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        // A window that says it is complete is the whole truth, so retaining
        // anything older would resurrect turns the session no longer has.
        store.applyHello(helloWith(5, 6, true));

        const turnIds = new Set(store.elements().map((element) => element.turnId));
        expect([...turnIds].sort()).toEqual(["run-5", "run-6"]);
    });
});
