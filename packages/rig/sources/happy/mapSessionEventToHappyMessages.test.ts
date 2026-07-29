import { describe, expect, it } from "vitest";

import type { SessionEvent } from "../protocol/index.js";
import { HappyMessageMapper } from "./mapSessionEventToHappyMessages.js";

describe("HappyMessageMapper", () => {
    it("keeps transient provider blocks out of the durable Happy outbox", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("agent_event", {
            event: {
                content: "Hello from Rig",
                contentIndex: 0,
                partial: { blocks: [], id: "agent-1", role: "agent" },
                type: "text_end",
            },
            runId: "run-1",
        });

        expect(mapper.map(event)).toEqual([]);
    });

    it("maps the durable final message to the same ids used by streaming recovery", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("agent_message", {
            message: {
                blocks: [
                    { text: "Hello from Rig", type: "text" },
                    { thinking: "Reasoning", type: "thinking" },
                    {
                        arguments: { path: "README.md" },
                        id: "call-1",
                        name: "Read",
                        presentation: {
                            type: "exploration",
                            operations: [{ kind: "read", name: "README.md" }],
                        },
                        type: "tool_call",
                    },
                ],
                id: "agent-1",
                role: "agent",
            },
            runId: "run-1",
        });

        const messages = mapper.map(event);

        expect(messages.map((message) => message.content.id)).toEqual([
            "agent-1:text:0",
            "agent-1:thinking:1",
            "agent-1:tool:call-1:start",
        ]);
        expect(messages.every((message) => message.content.turn === "run-1")).toBe(false);
        expect(messages.every((message) => message.content.turn === "agent-1")).toBe(true);
        expect(messages[2]?.content.ev).toMatchObject({
            presentation: {
                type: "exploration",
                operations: [{ kind: "read", name: "README.md" }],
            },
        });
    });

    it("does not echo a mobile-origin user message back into Happy", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("message_submitted", {
            displayText: "from phone",
            message: {
                blocks: [{ text: "from phone", type: "text" }],
                id: "happy:message-4",
                role: "user",
            },
            runId: "run-1",
        });

        expect(mapper.map(event)).toEqual([]);
    });

    it("maps a Bash call as the concrete command even when its result failed", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("agent_message", {
            message: {
                blocks: [
                    {
                        arguments: { command: "pnpm test" },
                        id: "call-bash",
                        name: "Bash",
                        presentation: {
                            command: "pnpm test",
                            type: "exec_command",
                        },
                        type: "tool_call",
                    },
                    {
                        display: "Command exited with code 1.",
                        isError: true,
                        rendered: [{ text: "Command exited with code 1.", type: "text" }],
                        toolCallId: "call-bash",
                        toolName: "Bash",
                        type: "tool_result",
                    },
                ],
                id: "agent-1",
                role: "agent",
            },
            runId: "run-1",
        });

        expect(mapper.map(event)[0]?.content.ev).toMatchObject({
            call: "call-bash",
            name: "Bash",
            presentation: {
                command: "pnpm test",
                type: "exec_command",
            },
            t: "tool-call-start",
        });
    });

    it("keeps every inference iteration in one group across a tool call", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [
                                {
                                    arguments: { command: "pnpm test" },
                                    id: "call-1",
                                    name: "Bash",
                                    type: "tool_call",
                                },
                            ],
                            id: "agent-1",
                            role: "agent",
                        },
                        runId: "run-1",
                    },
                    110,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            result: {
                                isError: false,
                                toolCallId: "call-1",
                                toolName: "Bash",
                            },
                            type: "tool_execution_end",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    130,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [{ text: "Done.", type: "text" }],
                            id: "agent-2",
                            role: "agent",
                        },
                        runId: "run-1",
                    },
                    140,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    { modelLocked: false, runId: "run-1", stopReason: "stop" },
                    150,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "tool-call-start",
            "tool-call-end",
            "text",
            "turn-end",
        ]);
        expect(output.every((message) => message.content.turn === "agent-1")).toBe(true);
        expect(output.at(-1)?.content.ev).toMatchObject({
            elapsedMs: 50,
            reason: "completed",
            status: "completed",
        });
    });

    it("emits retried and terminal failures as the same event kind inside the group", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90));
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "inference_retry",
                    {
                        attempt: 1,
                        reason: "The provider connection was lost.",
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    {
                        errorMessage: "The provider remained unavailable.",
                        modelLocked: false,
                        runId: "run-1",
                        stopReason: "error",
                    },
                    150,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "failure",
            "failure",
            "turn-end",
        ]);
        expect(output.every((message) => message.content.turn === "agent-1")).toBe(true);
        expect(output[1]?.content.ev).toEqual({
            attempt: 1,
            outcome: "retried",
            reason: "The provider connection was lost.",
            t: "failure",
        });
        expect(output[2]?.content.ev).toEqual({
            outcome: "failed",
            reason: "The provider remained unavailable.",
            t: "failure",
        });
    });

    it("reports a run error that happens before the first inference", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(sessionEvent("run_started", { runId: "run-1" }, 100)),
            ...mapper.map(
                sessionEvent(
                    "run_error",
                    {
                        errorMessage: "MCP initialization failed.",
                        modelLocked: false,
                        runId: "run-1",
                    },
                    130,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual(["failure", "turn-end"]);
        expect(output.every((message) => message.content.turn === "run-1")).toBe(true);
        expect(output[0]?.content.ev).toEqual({
            outcome: "failed",
            reason: "MCP initialization failed.",
            t: "failure",
        });
        expect(output[1]?.content.ev).toEqual({
            elapsedMs: 30,
            reason: "error",
            status: "failed",
            t: "turn-end",
            turnElapsedMs: 30,
        });
    });

    it("reports a failed run finish that happens before the first inference", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(sessionEvent("run_started", { runId: "run-1" }, 100)),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    {
                        errorMessage: "Runtime initialization failed.",
                        modelLocked: false,
                        runId: "run-1",
                        stopReason: "error",
                    },
                    130,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual(["failure", "turn-end"]);
        expect(output.every((message) => message.content.turn === "run-1")).toBe(true);
        expect(output[0]?.content.ev).toEqual({
            outcome: "failed",
            reason: "Runtime initialization failed.",
            t: "failure",
        });
        expect(output[1]?.content.ev).toEqual({
            elapsedMs: 30,
            reason: "error",
            status: "failed",
            t: "turn-end",
            turnElapsedMs: 30,
        });
    });

    it("closes the current group at compaction before the next inference group", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            compactionId: "compaction-1",
                            estimatedTokensBefore: 100,
                            reason: "threshold",
                            type: "context_compaction_started",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            compactedMessageCount: 5,
                            compactionId: "compaction-1",
                            elapsedMs: 5,
                            estimatedTokensAfter: 40,
                            estimatedTokensBefore: 100,
                            reason: "threshold",
                            type: "context_compacted",
                        },
                        runId: "run-1",
                    },
                    125,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    130,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "turn-end",
            "service",
            "turn-start",
        ]);
        expect(output[1]?.content.ev).toMatchObject({
            elapsedMs: 20,
            reason: "compaction",
            status: "completed",
        });
        expect(output[2]?.content).toMatchObject({
            ev: { t: "service", text: "Context compacted." },
            turn: "agent-2",
        });
        expect(output[3]?.content.turn).toBe("agent-2");
    });

    it("emits an empty group start, then closes steering before its messages and next group", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Original question",
                    message: {
                        blocks: [{ text: "Original question", type: "text" }],
                        id: "user-1",
                        role: "user",
                    },
                    runId: "run-1",
                },
                80,
            ),
        );
        mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90));
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "steer",
                        displayText: "First",
                        message: {
                            blocks: [{ text: "First", type: "text" }],
                            id: "steer-1",
                            role: "user",
                        },
                        runId: "run-1",
                    },
                    110,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "steer",
                        displayText: "Second",
                        message: {
                            blocks: [{ text: "Second", type: "text" }],
                            id: "steer-2",
                            role: "user",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "steering_applied",
                    { messageIds: ["steer-1", "steer-2"], runId: "run-1" },
                    150,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    160,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    { modelLocked: false, runId: "run-1", stopReason: "stop" },
                    200,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "turn-end",
            "text",
            "text",
            "turn-start",
            "turn-end",
        ]);
        expect(output[1]?.content.ev).toMatchObject({
            elapsedMs: 50,
            reason: "steering",
            turnElapsedMs: 70,
        });
        expect(output.slice(1, 4).map((message) => message.content.id)).toEqual([
            "group:agent-1:end",
            "steer-1",
            "steer-2",
        ]);
        expect(output.slice(2, 4).map((message) => message.content.turn)).toEqual([
            "agent-2",
            "agent-2",
        ]);
        expect(output[5]?.content.ev).toMatchObject({
            elapsedMs: 50,
            reason: "completed",
            turnElapsedMs: 120,
        });
    });

    it("does not emit a second end when run completion follows abort", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "agent_event",
                {
                    event: {
                        iteration: 1,
                        messageId: "agent-1",
                        type: "inference_iteration_start",
                    },
                    runId: "run-1",
                },
                100,
            ),
        );
        const aborted = mapper.map(sessionEvent("abort_requested", { runId: "run-1" }, 120));
        const finished = mapper.map(
            sessionEvent(
                "run_finished",
                { modelLocked: false, runId: "run-1", stopReason: "aborted" },
                130,
            ),
        );

        expect(aborted.map((message) => message.content.ev.t)).toEqual(["turn-end"]);
        expect(finished).toEqual([]);
    });
});

function sessionEvent(type: SessionEvent["type"], data: unknown, createdAt = 123): SessionEvent {
    return {
        createdAt,
        data,
        id: `event-${String(createdAt)}`,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}
