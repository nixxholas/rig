import { describe, expect, it, vi } from "vitest";

import type { ManagedSubagent } from "../../context/SubagentContext.js";
import { claudeTaskOutputTool } from "../../tools/claude/TaskOutput.js";
import { claudeTaskStopTool } from "../../tools/claude/TaskStop.js";
import { createJustBashToolHarness } from "../../../tools/testing/createJustBashToolHarness.js";

describe("Claude background-agent task tools", () => {
    it("waits for a background Agent and returns its final output", async () => {
        const harness = createJustBashToolHarness();
        let agent: ManagedSubagent = {
            agentId: "unguessable-agent-1",
            description: "Inspect tests",
            path: "/root/inspect_tests",
            status: "running",
        };
        const wait = vi.fn(async () => {
            agent = {
                ...agent,
                output: "The test audit is complete.",
                status: "completed",
            };
            return { agents: [agent], timedOut: false };
        });
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            inspect: () => agent,
            interrupt: vi.fn(),
            list: () => [agent],
            maxDepth: 3,
            spawn: vi.fn(),
            wait,
        };

        await expect(
            harness.runTool(claudeTaskOutputTool, {
                block: true,
                task_id: "unguessable-agent-1",
                timeout: 1_000,
            }),
        ).resolves.toEqual({
            retrieval_status: "success",
            task: {
                agentId: "unguessable-agent-1",
                output: "The test audit is complete.",
                path: "/root/inspect_tests",
                status: "completed",
                task_type: "local_agent",
            },
        });
        expect(wait).toHaveBeenCalledOnce();
    });

    it("stops a running background Agent by canonical path", async () => {
        const harness = createJustBashToolHarness();
        const agent: ManagedSubagent = {
            agentId: "unguessable-agent-1",
            description: "Inspect tests",
            path: "/root/inspect_tests",
            status: "running",
        };
        const interrupt = vi.fn(async () => ({ ...agent, status: "aborted" as const }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            inspect: () => agent,
            interrupt,
            list: () => [agent],
            maxDepth: 3,
            spawn: vi.fn(),
            wait: vi.fn(),
        };

        await expect(
            harness.runTool(claudeTaskStopTool, { task_id: "/root/inspect_tests" }),
        ).resolves.toEqual({
            agentId: "unguessable-agent-1",
            message: "The background agent was stopped.",
            path: "/root/inspect_tests",
            task_type: "local_agent",
        });
        expect(interrupt).toHaveBeenCalledWith("unguessable-agent-1");
    });
});
