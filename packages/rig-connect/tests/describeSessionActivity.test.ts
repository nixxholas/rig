import { describe, expect, it } from "vitest";

import { classifyToolName, describeSessionActivity } from "@/describeSessionActivity.js";
import type { SessionActivity, SessionActivityToolCall } from "@/protocol.js";

function running(toolCalls: readonly SessionActivityToolCall[]): SessionActivity {
    return {
        kind: "executing_tool_call",
        label: "Running tools",
        since: 10,
        toolCalls,
    };
}

function toolCall(toolName: string, toolCallId = toolName): SessionActivityToolCall {
    return { startedAt: 10, toolCallId, toolName };
}

describe("classifyToolName", () => {
    it("sorts every provider's shell tool into one category", () => {
        expect(classifyToolName("Bash")).toBe("shell");
        expect(classifyToolName("exec_command")).toBe("shell");
        expect(classifyToolName("run_terminal_command")).toBe("shell");
        expect(classifyToolName("bash")).toBe("shell");
    });

    it("recognises the tools that start and follow subagents", () => {
        expect(classifyToolName("Agent")).toBe("subagent");
        expect(classifyToolName("spawn_workspace_agent")).toBe("subagent");
        expect(classifyToolName("wait_agent")).toBe("subagent");
    });

    it("classifies every explicit web and X search tool as web activity", () => {
        for (const toolName of [
            "web_fetch",
            "gemini_web_search",
            "claude_web_search",
            "codex_web_search",
            "grok_web_search",
            "grok_x_search",
        ]) {
            expect(classifyToolName(toolName)).toBe("web");
        }
    });

    it("treats any MCP tool as external, whichever server named it", () => {
        expect(classifyToolName("mcp__node_repl__js")).toBe("mcp");
    });

    it("admits when it does not know a tool", () => {
        expect(classifyToolName("some_future_tool")).toBe("unknown");
    });
});

describe("describeSessionActivity", () => {
    it("reports the tools the session is waiting on", () => {
        const description = describeSessionActivity(running([toolCall("Bash")]));

        expect(description.awaitingTools).toEqual([toolCall("Bash")]);
        expect(description.label).toBe("Waiting for bash");
        expect(description.toolCategory).toBe("shell");
    });

    it("reports the tools whose automatic permissions are being reviewed", () => {
        const reviewing = { ...toolCall("Bash"), action: "running a host command" };
        const description = describeSessionActivity({
            kind: "reviewing_tool_call",
            label: "Reviewing Bash",
            reviewingToolCalls: [reviewing],
            since: 10,
        });

        expect(description.awaitingTools).toEqual([]);
        expect(description.reviewingTools).toEqual([reviewing]);
        expect(description.label).toBe("Reviewing Bash");
        expect(description.toolCategory).toBe("shell");
    });

    it("names the shared kind of work rather than counting the calls", () => {
        const description = describeSessionActivity(
            running([toolCall("Agent", "a"), toolCall("spawn_subagent", "b")]),
        );

        expect(description.label).toBe("Waiting for subagents");
        expect(description.toolCategory).toBe("subagent");
    });

    it("falls back to a count when the running tools have nothing in common", () => {
        const description = describeSessionActivity(
            running([toolCall("Bash", "a"), toolCall("Read", "b")]),
        );

        expect(description.label).toBe("Running 2 tools");
        expect(description.toolCategory).toBe("unknown");
    });

    it("names an unfamiliar single tool instead of guessing at its work", () => {
        const description = describeSessionActivity(running([toolCall("some_future_tool")]));

        expect(description.label).toBe("Running some_future_tool");
        expect(description.toolCategory).toBe("unknown");
    });

    it("keeps the awaited tools visible while a higher-precedence state describes the session", () => {
        // The question is what blocks the session, but the tool underneath it is
        // still running, so a UI that lists it must not lose it.
        const description = describeSessionActivity({
            ...running([toolCall("Bash")]),
            kind: "awaiting_input",
            label: "Waiting for an answer",
            pendingInputRequestIds: ["request-1"],
        });

        expect(description.label).toBe("Waiting for an answer");
        expect(description.awaitingTools).toEqual([toolCall("Bash")]);
        expect(description.toolCategory).toBeUndefined();
    });

    it("prefers the retry reason over the work it interrupted", () => {
        const description = describeSessionActivity({
            ...running([toolCall("Bash")]),
            kind: "retrying",
            label: "Retrying: rate limited",
            retry: { attempt: 2, reason: "rate limited" },
        });

        expect(description.label).toBe("Retrying: rate limited");
    });

    it("describes a session that is not running tools at all", () => {
        expect(describeSessionActivity({ kind: "idle", label: "Idle", since: 0 })).toEqual({
            awaitingTools: [],
            kind: "idle",
            label: "Idle",
            reviewingTools: [],
        });
        expect(
            describeSessionActivity({ kind: "generating_message", label: "x", since: 0 }).label,
        ).toBe("Writing a reply");
    });

    it("keeps the daemon's own wording for a scheduled wait, which carries its due time", () => {
        const description = describeSessionActivity({
            kind: "waiting",
            label: "Waiting until 3:00 PM",
            since: 0,
            wait: { dueAt: 100, startedAt: 0, toolCallId: "tool-1" },
        });

        expect(description.label).toBe("Waiting until 3:00 PM");
    });
});
