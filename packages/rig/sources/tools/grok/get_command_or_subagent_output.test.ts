import { setTimeout as delay } from "node:timers/promises";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import type { ManagedSubagent, SubagentContext } from "../../agent/index.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { grokGetCommandOrSubagentOutputTool } from "./get_command_or_subagent_output.js";

describe("get_command_or_subagent_output", () => {
    it("waits for subagents with a positive timeout and is steerable", async () => {
        const harness = createJustBashToolHarness();
        let completed = false;
        void delay(20).then(() => {
            completed = true;
        });
        harness.context.subagents = subagentContext(() => completed);

        const result = await grokGetCommandOrSubagentOutputTool.execute(
            { task_ids: ["unguessable-agent-1"], timeout_ms: 500 },
            harness.context,
            { ctx: harness.ctx },
        );

        expect(result.results).toEqual([
            expect.objectContaining({
                agent_id: "unguessable-agent-1",
                path: "/root/test_subagent",
                status: "completed",
            }),
        ]);
        expect(grokGetCommandOrSubagentOutputTool.steerable).toBe(true);
        expect(
            Value.Check(grokGetCommandOrSubagentOutputTool.arguments, {
                task_ids: ["agent-1"],
                timeout_ms: 3_600_001,
            }),
        ).toBe(false);
    });

    it("stops a blocking read when its execution signal is aborted", async () => {
        const harness = createJustBashToolHarness();
        harness.context.subagents = subagentContext(() => false);
        const controller = new AbortController();
        const reading = grokGetCommandOrSubagentOutputTool.execute(
            { task_ids: ["/root/test_subagent"], timeout_ms: 500 },
            harness.context,
            { ctx: harness.ctx, signal: controller.signal },
        );

        controller.abort();

        await expect(reading).rejects.toThrow("cancelled");
    });

    it("rejects task lists that normalize to no IDs", async () => {
        const harness = createJustBashToolHarness();

        await expect(
            grokGetCommandOrSubagentOutputTool.execute(
                { task_ids: ["  "], timeout_ms: 0 },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("at least one non-empty task ID");
    });
});

function subagentContext(completed: () => boolean): SubagentContext {
    const agent = (): ManagedSubagent => ({
        agentId: "unguessable-agent-1",
        description: "Test subagent",
        path: "/root/test_subagent",
        status: completed() ? "completed" : "running",
    });
    return {
        canSpawn: true,
        depth: 0,
        followUp: vi.fn(async () => agent()),
        interrupt: vi.fn(async () => agent()),
        list: vi.fn(() => [agent()]),
        maxDepth: 3,
        spawn: vi.fn(),
        wait: vi.fn(),
    };
}
