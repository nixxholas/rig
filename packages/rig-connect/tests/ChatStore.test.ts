import { describe, expect, it } from "vitest";

import { ChatStore } from "@/ChatStore.js";
import type { ChatDelta, ChatElement, ToolCallElement } from "@/ChatElement.js";
import type { AgentLoopEvent, SessionEvent, SessionStreamHello } from "@/protocol.js";

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
            cwd: "/work",
            id: "session-1",
            modelId: "sonnet-5",
            providerId: "claude",
            snapshot: { messages: [] },
            status: "idle",
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
                    { detail: "sources", label: "List" },
                    { detail: "ChatStore.ts", label: "Read" },
                    { detail: "todo", label: "Search", path: "sources" },
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

    it("reports a retry starting and finishing from the session activity", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const started = store.apply(
            event("session_activity_changed", {
                activity: {
                    kind: "retrying",
                    label: "Retrying: rate limited",
                    retry: { attempt: 2, reason: "rate limited" },
                    since: 1,
                },
            }),
        );
        expect(started.map((delta) => delta.type)).toContain("retry_started");

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
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        const message = event("agent_message", {
            message: { blocks: [{ text: "Once.", type: "text" }], id: "m1", role: "agent" },
            runId: "run-1",
        });
        store.apply(message);
        store.apply(message);

        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(1);
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

    it("ignores an event it does not recognise", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const before = store.elements();

        expect(store.apply(event("something_new", { whatever: true }))).toEqual([]);
        expect(store.elements()).toBe(before);
    });

    describe("live session facts", () => {
        it("removes a title the daemon cleared", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));

            store.apply(event("session_title_changed", { status: "pending" }));

            // A title is cleared by omission. Leaving the old one on screen
            // would show a name the session no longer has.
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

        it("reports the real outcome and duration of a historical turn", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            const ends = store.elements().filter((element) => element.kind === "turn_end");
            expect(ends[0]).toMatchObject({ elapsedMs: 500, outcome: "success" });
            expect(ends[1]).toMatchObject({ errorMessage: "It broke", outcome: "error" });
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
});
