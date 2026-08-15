import { describe, expect, it, vi } from "vitest";

import type { AgentContext, ChatHistoryPage } from "../agent/index.js";
import { readAgentHistoryTool } from "./read_agent_history.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";

describe("read_agent_history", () => {
    it("reads a selected subagent and lists the complete session tree", () => {
        const page: ChatHistoryPage = {
            agent: {
                agentId: "child-agent-id",
                description: "Inspect history",
                messageCount: 1,
                path: "/root/audit",
                status: "completed",
            },
            agents: [
                {
                    agentId: "root-agent-id",
                    messageCount: 4,
                    path: "/root",
                    status: "idle",
                },
                {
                    agentId: "child-agent-id",
                    description: "Inspect history",
                    messageCount: 1,
                    path: "/root/audit",
                    status: "completed",
                },
            ],
            cursor: 0,
            matchedMessages: 1,
            matchedStats: stats({ assistantMessages: 1, messages: 1 }),
            messages: [
                {
                    message: {
                        blocks: [{ text: "Subagent result.", type: "text" }],
                        id: "child-answer",
                        role: "agent",
                        usage: zeroUsage(),
                    },
                    position: 0,
                },
            ],
            totalStats: stats({ assistantMessages: 1, messages: 1 }),
            totalMessages: 1,
        };
        const read = vi.fn(() => page);
        const context = { chatHistory: { read } } as unknown as AgentContext;
        const ctx = createTestRootContext().named("read-agent-history-test");

        expect(readAgentHistoryTool.name).toBe("read_agent_history");
        expect(readAgentHistoryTool.description).toContain("low-level inference history");
        expect(readAgentHistoryTool.description).toContain("80,000 characters");
        expect(readAgentHistoryTool.description).toContain("hidden reasoning");
        expect(readAgentHistoryTool.arguments.properties.limit.maximum).toBe(500);
        expect(readAgentHistoryTool.arguments.properties.limit.description).toContain(
            "may return fewer",
        );
        expect(
            readAgentHistoryTool.arguments.properties.from.anyOf.map(
                (option: { const: string }) => option.const,
            ),
        ).toEqual(["start", "begin", "beginning", "end", "last"]);

        const result = readAgentHistoryTool.execute(
            {
                from: "end",
                include_tools: false,
                limit: 20,
                query: "result",
                roles: ["assistant"],
                target: "/root/audit",
            },
            context,
            { ctx },
        );

        expect(read).toHaveBeenCalledWith({
            from: "end",
            limit: 20,
            query: "result",
            roles: ["assistant"],
            target: "/root/audit",
        });
        expect(result).toMatchObject({
            agents: [
                { agent_id: "root-agent-id", path: "/root" },
                { agent_id: "child-agent-id", path: "/root/audit" },
            ],
            history: expect.stringContaining("Subagent result."),
            matched_messages: 1,
            returned_messages: 1,
            stats: {
                matched: expect.objectContaining({ messages: 1 }),
                returned: expect.objectContaining({ messages: 1 }),
                total: expect.objectContaining({ messages: 1 }),
            },
            target: "/root/audit",
        });

        readAgentHistoryTool.execute({ roles: ["error"] }, context, { ctx });
        expect(read).toHaveBeenLastCalledWith({ limit: 100, roles: ["error"] });

        readAgentHistoryTool.execute({}, context, { ctx });
        expect(read).toHaveBeenLastCalledWith({ limit: 100 });

        readAgentHistoryTool.execute({ from: "beginning" } as never, context, { ctx });
        expect(read).toHaveBeenLastCalledWith({ from: "start", limit: 100 });

        readAgentHistoryTool.execute({ from: "begin" } as never, context, { ctx });
        expect(read).toHaveBeenLastCalledWith({ from: "start", limit: 100 });

        readAgentHistoryTool.execute({ from: "last" } as never, context, { ctx });
        expect(read).toHaveBeenLastCalledWith({ from: "end", limit: 100 });
    });
});

function stats(overrides: Partial<ReturnType<typeof zeroStats>>) {
    return { ...zeroStats(), ...overrides };
}

function zeroStats() {
    return {
        assistantMessages: 0,
        messages: 0,
        textCharacters: 0,
        thinkingBlocks: 0,
        toolCalls: 0,
        toolResults: 0,
        userMessages: 0,
    };
}

function zeroUsage() {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
}
