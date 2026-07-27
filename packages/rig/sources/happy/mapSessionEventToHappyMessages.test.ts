import { describe, expect, it } from "vitest";

import type { SessionEvent } from "../protocol/index.js";
import { mapSessionEventToHappyMessages } from "./mapSessionEventToHappyMessages.js";

describe("mapSessionEventToHappyMessages", () => {
    it("keeps transient provider blocks out of the durable Happy outbox", () => {
        const event = sessionEvent("agent_event", {
            event: {
                content: "Hello from Rig",
                contentIndex: 0,
                partial: { blocks: [], id: "agent-1", role: "agent" },
                type: "text_end",
            },
            runId: "run-1",
        });

        expect(mapSessionEventToHappyMessages(event)).toEqual([]);
    });

    it("maps the durable final message to the same ids used by streaming recovery", () => {
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

        expect(mapSessionEventToHappyMessages(event).map((message) => message.content.id)).toEqual([
            "agent-1:text:0",
            "agent-1:thinking:1",
            "agent-1:tool:call-1:start",
        ]);
        expect(
            mapSessionEventToHappyMessages(event).every(
                (message) => message.content.turn === "run-1",
            ),
        ).toBe(true);
        expect(mapSessionEventToHappyMessages(event)[2]?.content.ev).toMatchObject({
            presentation: {
                type: "exploration",
                operations: [{ kind: "read", name: "README.md" }],
            },
        });
    });

    it("does not echo a mobile-origin user message back into Happy", () => {
        const event = sessionEvent("message_submitted", {
            displayText: "from phone",
            message: {
                blocks: [{ text: "from phone", type: "text" }],
                id: "happy:message-4",
                role: "user",
            },
            runId: "run-1",
        });

        expect(mapSessionEventToHappyMessages(event)).toEqual([]);
    });

    it("maps a Bash call as the concrete command even when its result failed", () => {
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

        expect(mapSessionEventToHappyMessages(event)[0]?.content.ev).toMatchObject({
            call: "call-bash",
            name: "Bash",
            presentation: {
                command: "pnpm test",
                type: "exec_command",
            },
            t: "tool-call-start",
        });
    });
});

function sessionEvent(type: SessionEvent["type"], data: unknown): SessionEvent {
    return { createdAt: 123, data, id: "event-1", sessionId: "session-1", type } as SessionEvent;
}
