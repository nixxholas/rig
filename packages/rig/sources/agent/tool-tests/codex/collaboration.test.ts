import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";

import type { ManagedSubagent, SpawnSubagentRequest } from "../../index.js";
import { claudeSendMessageTool } from "../../tools/claude/SendMessage.js";
import { createJustBashToolHarness } from "../../../tools/testing/createJustBashToolHarness.js";
import { assembleCodexTools } from "../../tools/codex/assembleCodexTools.js";
import { codexV1SpawnAgentTool } from "../../tools/codex/v1/spawn_agent.js";
import { codexV1WaitAgentTool } from "../../tools/codex/v1/wait_agent.js";
import { codexFollowupTaskTool } from "../../tools/codex/v2/followup_task.js";
import { codexInterruptAgentTool } from "../../tools/codex/v2/interrupt_agent.js";
import { codexListAgentsTool } from "../../tools/codex/v2/list_agents.js";
import { codexSendMessageTool } from "../../tools/codex/v2/send_message.js";
import { codexSpawnAgentTool } from "../../tools/codex/v2/spawn_agent.js";
import { codexExtendedFollowupTaskTool } from "../../tools/codex/v2/collaboration_ext/followup_task.js";
import { codexExtendedSpawnAgentTool } from "../../tools/codex/v2/collaboration_ext/spawn_agent.js";
import { codexWaitAgentTool } from "../../tools/codex/v2/wait_agent.js";

describe("Codex collaboration tools", () => {
    it("selects plaintext v1 for Bedrock and encrypted v2 for Codex Cloud", () => {
        const collaboration = assembleCodexTools("openai/gpt-5.6-sol", "codex").filter(
            (tool) => tool.namespace?.name === "collaboration",
        );
        expect(collaboration.map((tool) => tool.name)).toEqual([
            "spawn_agent",
            "followup_task",
            "send_message",
            "wait_agent",
            "list_agents",
            "interrupt_agent",
        ]);
        expect(
            assembleCodexTools("openai/gpt-5.6-sol", "codex")
                .filter((tool) => tool.namespace?.name === "collaboration_ext")
                .map((tool) => tool.name),
        ).toEqual(["spawn_agent", "followup_task"]);

        const bedrock = assembleCodexTools("openai/gpt-5.6-sol", "bedrock").filter(
            (tool) => tool.namespace?.name === "multi_agent_v1",
        );
        expect(bedrock.map((tool) => tool.name)).toEqual([
            "close_agent",
            "resume_agent",
            "send_input",
            "spawn_agent",
            "wait_agent",
        ]);

        const luna = assembleCodexTools("openai/gpt-5.6-luna", "codex").filter(
            (tool) => tool.namespace?.name === "multi_agent_v1",
        );
        expect(luna.map((tool) => tool.name)).toEqual([
            "close_agent",
            "resume_agent",
            "send_input",
            "spawn_agent",
            "wait_agent",
        ]);
        expect(
            assembleCodexTools("openai/gpt-5.6-luna", "codex").some(
                (tool) => tool.namespace?.name === "collaboration",
            ),
        ).toBe(false);
        expect(
            assembleCodexTools("openai/gpt-5.6-sol", "bedrock").some(
                (tool) => tool.namespace?.name === "collaboration",
            ),
        ).toBe(false);
    });

    it("exposes background spawn and lifecycle controls", async () => {
        const harness = createJustBashToolHarness();
        const agent: ManagedSubagent = {
            agentId: "unguessable-agent-1",
            description: "Inspect code",
            path: "/root/inspect_code",
            status: "running",
        };
        const spawn = vi.fn(async () => ({
            agentId: agent.agentId,
            output: "The subagent is running in the background.",
            path: agent.path,
            status: "running" as const,
        }));
        const followUp = vi.fn(() => agent);
        const interrupt = vi.fn(() => agent);
        const list = vi.fn(() => [agent]);
        const wait = vi.fn(async () => ({ agents: [agent], timedOut: false }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp,
            interrupt,
            list,
            maxDepth: 3,
            spawn,
            wait,
        };

        await expect(
            codexSpawnAgentTool.execute(
                {
                    fork_turns: "none",
                    message: "Inspect the implementation.",
                    model: "anthropic/claude-sonnet-4.6",
                    reasoning_effort: "high",
                    task_name: "inspect_code",
                },
                harness.context,
                { toolCallId: "tool-1" },
            ),
        ).resolves.toEqual({
            agent_id: "unguessable-agent-1",
            path: "/root/inspect_code",
        });
        expect(spawn).toHaveBeenCalledWith(
            {
                background: true,
                contextMode: "task",
                description: "Inspect code",
                effort: "high",
                modelId: "anthropic/claude-sonnet-4.6",
                parentToolCallId: "tool-1",
                prompt: "Inspect the implementation.",
                taskName: "inspect_code",
            },
            undefined,
        );

        await expect(
            codexFollowupTaskTool.execute(
                { message: "Check the tests too.", target: "unguessable-agent-1" },
                harness.context,
                {},
            ),
        ).resolves.toEqual({
            agent_id: "unguessable-agent-1",
            path: "/root/inspect_code",
            status: "running",
        });
        expect(followUp).toHaveBeenCalledWith("unguessable-agent-1", "Check the tests too.");
        await expect(
            claudeSendMessageTool.execute(
                {
                    effort: "low",
                    message: "Review the final diff.",
                    summary: "Review final changes",
                    to: "/root/inspect_code",
                },
                harness.context,
                {},
            ),
        ).resolves.toEqual({
            agentId: "unguessable-agent-1",
            message: "Review final changes: follow-up work was sent to Inspect code.",
            path: "/root/inspect_code",
            success: true,
        });
        expect(followUp).toHaveBeenLastCalledWith(
            "/root/inspect_code",
            "Review the final diff.",
            "low",
        );
        expect(codexListAgentsTool.execute({}, harness.context, {})).toEqual({
            agents: [
                {
                    agent_id: "unguessable-agent-1",
                    agent_status: "running",
                    path: "/root/inspect_code",
                },
            ],
        });
        expect(
            codexInterruptAgentTool.execute({ target: "unguessable-agent-1" }, harness.context, {}),
        ).toEqual({
            agent_id: "unguessable-agent-1",
            path: "/root/inspect_code",
            previous_status: "running",
        });
        await expect(
            codexWaitAgentTool.execute({ timeout_ms: 300_000 }, harness.context, {}),
        ).resolves.toEqual({
            agents: [
                {
                    agent_id: "unguessable-agent-1",
                    path: "/root/inspect_code",
                    status: "running",
                },
            ],
            message: "Wait completed.",
            timed_out: false,
        });
        expect(Value.Check(codexWaitAgentTool.arguments, { timeout_ms: 300_000 })).toBe(true);
        expect(Value.Check(codexWaitAgentTool.arguments, { timeout_ms: 3_600_001 })).toBe(false);
        expect(codexWaitAgentTool.steerable).toBe(true);
    });

    it("waits an hour by default and refuses a short polling interval", async () => {
        const harness = createJustBashToolHarness();
        let requestedTimeout: number | undefined;
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: vi.fn(() => []),
            maxDepth: 3,
            spawn: vi.fn(),
            wait: vi.fn(async (timeoutMs?: number) => {
                requestedTimeout = timeoutMs;
                return { agents: [], timedOut: true };
            }),
        };

        await codexWaitAgentTool.execute({}, harness.context, {});

        expect(requestedTimeout).toBe(3_600_000);
        expect(Value.Check(codexWaitAgentTool.arguments, { timeout_ms: 30_000 })).toBe(false);
        expect(Value.Check(codexWaitAgentTool.arguments, { timeout_ms: 60_000 })).toBe(true);
    });

    it("targets a stable Agent ID without consulting legacy aliases", () => {
        const harness = createJustBashToolHarness();
        const alias: ManagedSubagent = {
            agentId: "alias-agent",
            description: "Alias",
            path: "/root/alias",
            status: "running",
        };
        const identified: ManagedSubagent = {
            agentId: "stable-target",
            description: "Identified",
            path: "/root/identified",
            status: "running",
        };
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(() => identified),
            list: vi.fn(() => [alias, identified]),
            maxDepth: 3,
            spawn: vi.fn(),
            wait: vi.fn(),
        };

        expect(
            codexInterruptAgentTool.execute({ target: "stable-target" }, harness.context, {}),
        ).toEqual({
            agent_id: "stable-target",
            path: "/root/identified",
            previous_status: "running",
        });
    });

    it("requires an explicit model and reasoning effort for every spawned agent", () => {
        const spawnArguments = {
            fork_turns: "none",
            message: "Inspect the implementation.",
            task_name: "inspect_code",
        };

        expect(Value.Check(codexSpawnAgentTool.arguments, spawnArguments)).toBe(false);
        expect(
            Value.Check(codexSpawnAgentTool.arguments, {
                ...spawnArguments,
                model: "openai/gpt-5.6-sol",
                reasoning_effort: "medium",
            }),
        ).toBe(true);
        expect(
            Value.Check(codexV1SpawnAgentTool.arguments, {
                message: "Inspect the implementation.",
                model: "openai/gpt-5.6-sol",
                reasoning_effort: "medium",
            }),
        ).toBe(true);
        expect(
            Value.Check(codexV1SpawnAgentTool.arguments, {
                message: "Inspect the implementation.",
            }),
        ).toBe(false);
    });

    it("spawns a plaintext v2 subagent through an explicit non-GPT provider", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async (_request: SpawnSubagentRequest, _signal?: AbortSignal) => ({
            agentId: "unguessable-agent-claude",
            output: "The subagent is running in the background.",
            path: "/root/review_claude",
            sessionId: "agent-claude",
            status: "running" as const,
            taskName: "review_claude",
        }));
        const managed: ManagedSubagent = {
            agentId: "unguessable-agent-claude",
            description: "Review claude",
            path: "/root/review_claude",
            status: "completed",
        };
        const followUp = vi.fn(() => managed);
        harness.context.subagents = {
            availableModels: [
                {
                    defaultEffort: "high",
                    effortLevels: ["low", "high"],
                    id: "anthropic/claude-sonnet-4.6",
                    name: "Claude Sonnet 4.6",
                    providerId: "claude",
                },
            ],
            canSpawn: true,
            depth: 0,
            encryptedMessages: true,
            followUp,
            interrupt: vi.fn(),
            list: vi.fn(() => []),
            maxDepth: 3,
            spawn,
            wait: vi.fn(async () => ({ agents: [], timedOut: false })),
        };
        const parentMessage = {
            blocks: [{ text: "Review the implementation.", type: "text" as const }],
            id: "parent-user",
            role: "user" as const,
        };
        const currentAgentMessage = {
            blocks: [],
            id: "parent-agent",
            role: "agent" as const,
        };
        const signal = new AbortController().signal;

        await expect(
            codexExtendedSpawnAgentTool.execute(
                {
                    fork_turns: "all",
                    message: "Audit the Claude integration.",
                    model: "anthropic/claude-sonnet-4.6",
                    provider: "claude",
                    reasoning_effort: "high",
                    task_name: "review_claude",
                },
                harness.context,
                {
                    messages: [parentMessage, currentAgentMessage],
                    signal,
                    toolCallId: "tool-ext",
                },
            ),
        ).resolves.toEqual({
            agent_id: "unguessable-agent-claude",
            path: "/root/review_claude",
        });
        expect(spawn).toHaveBeenCalledWith(
            {
                background: true,
                contextMessages: [parentMessage],
                contextMode: "parent",
                description: "Review claude",
                effort: "high",
                modelId: "anthropic/claude-sonnet-4.6",
                parentToolCallId: "tool-ext",
                prompt: "Audit the Claude integration.",
                providerId: "claude",
                taskName: "review_claude",
            },
            signal,
        );
        expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("encryptedPrompt");

        await expect(
            codexExtendedFollowupTaskTool.execute(
                {
                    message: "Check the final diff.",
                    reasoning_effort: "low",
                    target: "/root/review_claude",
                },
                harness.context,
                {},
            ),
        ).resolves.toEqual({
            agent_id: "unguessable-agent-claude",
            path: "/root/review_claude",
            status: "completed",
        });
        expect(followUp).toHaveBeenCalledWith(
            "/root/review_claude",
            "Check the final diff.",
            "low",
        );
    });

    it("passes native Codex collaboration messages through encrypted envelopes", async () => {
        const harness = createJustBashToolHarness();
        const agent: ManagedSubagent = {
            agentId: "unguessable-agent-1",
            description: "Inspect code",
            path: "/root/inspect_code",
            status: "running",
        };
        const spawn = vi.fn(async () => ({
            agentId: agent.agentId,
            output: "The subagent is running in the background.",
            path: agent.path,
            status: "running" as const,
        }));
        const followUp = vi.fn(() => agent);
        const sendMessage = vi.fn(() => agent);
        const setReadOnly = vi.fn(async () => agent);
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            encryptedMessages: true,
            followUp,
            interrupt: vi.fn(),
            list: vi.fn(() => [agent]),
            maxDepth: 3,
            sendMessage,
            setReadOnly,
            spawn,
            wait: vi.fn(async () => ({ agents: [agent], timedOut: false })),
        };

        await codexSpawnAgentTool.execute(
            {
                fork_turns: "none",
                message: "opaque-spawn-ciphertext",
                model: "openai/gpt-5.6-sol",
                read_only: true,
                reasoning_effort: "medium",
                task_name: "inspect_code",
            },
            harness.context,
            { toolCallId: "tool-1" },
        );
        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptedPrompt: "opaque-spawn-ciphertext",
                prompt: "",
                readOnly: true,
            }),
            undefined,
        );

        await codexFollowupTaskTool.execute(
            {
                message: "opaque-followup-ciphertext",
                read_only: true,
                target: "unguessable-agent-1",
            },
            harness.context,
            {},
        );
        expect(setReadOnly).toHaveBeenCalledWith("unguessable-agent-1", true);
        expect(followUp).toHaveBeenCalledWith(
            "unguessable-agent-1",
            "",
            undefined,
            "opaque-followup-ciphertext",
        );

        await codexSendMessageTool.execute(
            {
                message: "opaque-message-ciphertext",
                read_only: false,
                target: "/root/inspect_code",
            },
            harness.context,
            {},
        );
        expect(setReadOnly).toHaveBeenLastCalledWith("/root/inspect_code", false);
        expect(sendMessage).toHaveBeenCalledWith(
            "/root/inspect_code",
            "",
            "opaque-message-ciphertext",
        );
        expect(codexFollowupTaskTool.shouldReviewInAutoMode).toBeDefined();
        expect(
            await codexFollowupTaskTool.shouldReviewInAutoMode?.(
                {
                    message: "No escalation.",
                    read_only: false,
                    target: "unguessable-agent-1",
                },
                harness.context,
            ),
        ).toBe(false);
    });

    it("passes Bedrock v1 spawn messages to subagents as plaintext", async () => {
        const harness = createJustBashToolHarness();
        let observedRequest: SpawnSubagentRequest | undefined;
        const spawn = vi.fn(async (request: SpawnSubagentRequest) => {
            observedRequest = request;
            return {
                agentId: "unguessable-agent-1",
                output: "The subagent is running in the background.",
                path: "/root/delegated_task",
                sessionId: "agent-1",
                status: "running" as const,
                taskName: "delegated_task",
            };
        });
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            encryptedMessages: false,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: vi.fn(() => []),
            maxDepth: 3,
            spawn,
            wait: vi.fn(async () => ({ agents: [], timedOut: false })),
        };

        await expect(
            codexV1SpawnAgentTool.execute(
                {
                    agent_type: "worker",
                    fork_context: false,
                    message: "Inspect the Bedrock implementation.",
                    model: "openai/gpt-5.6-sol",
                    provider: "bedrock",
                    reasoning_effort: "medium",
                    service_tier: "priority",
                },
                harness.context,
                { toolCallId: "tool-v1" },
            ),
        ).resolves.toEqual({
            agent_id: "unguessable-agent-1",
            path: "/root/delegated_task",
        });
        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                contextMode: "task",
                description: "worker",
                prompt: "Inspect the Bedrock implementation.",
                providerId: "bedrock",
                serviceTier: "fast",
            }),
        );
        expect(observedRequest).not.toHaveProperty("encryptedPrompt");
    });

    it("keeps waiting when Bedrock v1 receives an unrelated agent update", async () => {
        const harness = createJustBashToolHarness();
        const unrelated: ManagedSubagent = {
            agentId: "unguessable-other",
            description: "Other task",
            path: "/root/other",
            status: "completed",
        };
        const target: ManagedSubagent = {
            agentId: "unguessable-target",
            description: "Target task",
            path: "/root/target",
            status: "completed",
        };
        const wait = vi
            .fn()
            .mockResolvedValueOnce({ agents: [unrelated], timedOut: false })
            .mockResolvedValueOnce({ agents: [target], timedOut: false });
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: vi.fn(() => [unrelated, target]),
            maxDepth: 3,
            spawn: vi.fn(),
            wait,
        };

        await expect(
            codexV1WaitAgentTool.execute(
                { targets: ["unguessable-target"], timeout_ms: 30_000 },
                harness.context,
                {},
            ),
        ).resolves.toEqual({
            agents: [
                {
                    agent_id: "unguessable-target",
                    path: "/root/target",
                    status: { completed: null },
                },
            ],
            status: { "unguessable-target": { completed: null } },
            timed_out: false,
        });
        expect(wait).toHaveBeenCalledTimes(2);
    });
});
