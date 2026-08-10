import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "./testing/createJustBashToolHarness.js";
import { claudeAgentTool } from "../agent/tools/claude/Agent.js";

describe("Agent tool", () => {
    it("starts a managed subagent and forwards the tool call identity", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            output: "The delegated task is complete.",
            path: "/root/inspect_tests",
            sessionId: "subagent-1",
            status: "completed" as const,
            taskName: "inspect_tests",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        const result = await claudeAgentTool.execute(
            {
                context: "task",
                description: "Inspect the tests",
                effort: "high",
                model: "anthropic/claude-sonnet-4.6",
                prompt: "Review the test suite.",
                run_in_background: false,
            },
            harness.context,
            { ctx: harness.ctx, toolCallId: "tool-1" },
        );

        expect(result).toMatchObject({
            agentId: "unguessable-agent-1",
            path: "/root/inspect_tests",
            status: "completed",
        });
        expect(claudeAgentTool.toLLM(result)).toEqual([
            { text: JSON.stringify(result), type: "text" },
        ]);
        expect(spawn).toHaveBeenCalledWith(
            {
                description: "Inspect the tests",
                contextMode: "task",
                effort: "high",
                modelId: "anthropic/claude-sonnet-4.6",
                parentToolCallId: "tool-1",
                prompt: "Review the test suite.",
            },
            undefined,
        );
    });

    it("rejects spawning after the maximum depth", async () => {
        const harness = createJustBashToolHarness();
        harness.context.subagents = {
            canSpawn: false,
            depth: 3,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn: vi.fn(),
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            claudeAgentTool.execute(
                {
                    context: "task",
                    description: "Go deeper",
                    effort: "medium",
                    model: "anthropic/sonnet-5",
                    prompt: "Start another agent.",
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("maximum subagent depth");
    });

    it("forwards the requested provider to the session manager", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            output: "The subagent is running in the background.",
            path: "/root/inspect_tests",
            sessionId: "subagent-1",
            status: "running" as const,
            taskName: "inspect_tests",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await claudeAgentTool.execute(
            {
                context: "task",
                description: "Inspect the tests",
                effort: "medium",
                model: "anthropic/sonnet-5",
                prompt: "Review the test suite.",
                provider: "claude",
            },
            harness.context,
            { ctx: harness.ctx },
        );
        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({ providerId: "claude" }),
            undefined,
        );
    });

    it("maps the requested priority service tier to fast", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            output: "The subagent is running in the background.",
            path: "/root/inspect_tests",
            sessionId: "subagent-1",
            status: "running" as const,
            taskName: "inspect_tests",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await claudeAgentTool.execute(
            {
                context: "task",
                description: "Inspect the tests",
                effort: "medium",
                model: "anthropic/sonnet-5",
                prompt: "Review the test suite.",
                service_tier: "priority",
            },
            harness.context,
            { ctx: harness.ctx },
        );

        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({ serviceTier: "fast" }),
            undefined,
        );
    });

    it("launches an Agent in the background by default", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "unguessable-agent-1",
            output: "The subagent is running in the background.",
            path: "/root/inspect_tests",
            sessionId: "subagent-1",
            status: "running" as const,
            taskName: "inspect_tests",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            claudeAgentTool.execute(
                {
                    context: "task",
                    description: "Inspect the tests",
                    effort: "medium",
                    model: "anthropic/sonnet-5",
                    prompt: "Review the test suite.",
                },
                harness.context,
                { ctx: harness.ctx, toolCallId: "tool-1" },
            ),
        ).resolves.toEqual({
            agentId: "unguessable-agent-1",
            path: "/root/inspect_tests",
            status: "async_launched",
        });
        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({ background: true }),
            undefined,
        );
    });

    it("reports a failed child as a failed tool call", async () => {
        const harness = createJustBashToolHarness();
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: () => [],
            maxDepth: 3,
            spawn: async () => ({
                agentId: "unguessable-agent-1",
                output: "The delegated check failed.",
                path: "/root/run_check",
                sessionId: "subagent-1",
                status: "error",
                taskName: "run_check",
            }),
            wait: async () => ({ agents: [], timedOut: false }),
        };

        await expect(
            claudeAgentTool.execute(
                {
                    context: "task",
                    description: "Run the check",
                    effort: "medium",
                    model: "anthropic/sonnet-5",
                    prompt: "Run the delegated check.",
                    run_in_background: false,
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("The delegated check failed");
    });
});
