import { describe, expect, it, vi } from "vitest";

import type { AgentContext, AgentTreeUsage } from "../agent/index.js";
import { getAgentTreeUsageTool } from "./get_agent_tree_usage.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";

describe("get_agent_tree_usage", () => {
    it("returns the managed durable breakdown without requesting permission review", async () => {
        const usage: AgentTreeUsage = {
            sessions: [
                {
                    agentId: "agent-root",
                    modelId: "openai/gpt-5.6-sol",
                    providerId: "codex",
                    relation: "root",
                    sessionId: "root",
                    status: "idle",
                    totalTokens: 100,
                },
                {
                    agentId: "agent-child",
                    modelId: "anthropic/sonnet-5",
                    parentSessionId: "root",
                    providerId: "claude",
                    relation: "delegated",
                    sessionId: "child",
                    status: "completed",
                    totalTokens: 40,
                },
            ],
            totalTokens: 140,
        };
        const read = vi.fn(() => usage);
        const context = { agentTreeUsage: { read } } as unknown as AgentContext;
        const ctx = createTestRootContext().named("agent-tree-usage-test");

        const result = await getAgentTreeUsageTool.execute({}, context, { ctx });
        expect(result).toEqual({
            sessions: [
                {
                    agentId: "agent-root",
                    modelId: "openai/gpt-5.6-sol",
                    path: "/root",
                    providerId: "codex",
                    relation: "root",
                    status: "idle",
                    totalTokens: 100,
                },
                {
                    agentId: "agent-child",
                    modelId: "anthropic/sonnet-5",
                    parentAgentId: "agent-root",
                    path: "/root",
                    providerId: "claude",
                    relation: "delegated",
                    status: "completed",
                    totalTokens: 40,
                },
            ],
            totalTokens: 140,
        });
        expect(read).toHaveBeenCalledOnce();
        expect(getAgentTreeUsageTool.shouldReviewInAutoMode({}, context)).toBe(false);
        expect(getAgentTreeUsageTool.requiresAutoOrFullAccess).toBe(false);
        expect(getAgentTreeUsageTool.locks).toEqual([]);
        expect(getAgentTreeUsageTool.toLLM(result)).toEqual([
            { type: "text", text: JSON.stringify(result) },
        ]);
    });
});
