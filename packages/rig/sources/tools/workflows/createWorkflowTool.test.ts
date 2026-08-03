import { describe, expect, it, vi } from "vitest";

import type { Message, SpawnSubagentRequest } from "../../agent/index.js";
import type { LaunchWorkflowRequest } from "../../workflows/WorkflowContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { createWorkflowTool } from "./createWorkflowTool.js";

describe("createWorkflowTool", () => {
    it("forwards the parent transcript to children that request parent context", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async (request: SpawnSubagentRequest) => ({
            agentId: `${request.taskName ?? "child"}-agent`,
            output: "Complete.",
            path: `/root/${request.taskName}`,
            sessionId: request.taskName ?? "child",
            status: "completed" as const,
            taskName: request.taskName ?? "child",
        }));
        harness.context.subagents = {
            canSpawn: true,
            depth: 0,
            followUp: vi.fn(),
            interrupt: vi.fn(),
            list: vi.fn(() => []),
            maxDepth: 3,
            spawn,
            wait: vi.fn(),
        };
        let launchRequest: LaunchWorkflowRequest | undefined;
        harness.context.workflows = {
            get: vi.fn(),
            launch: vi.fn((request) => {
                launchRequest = request;
                return {
                    agentCount: 0,
                    code: request.code,
                    description: request.description,
                    logs: [],
                    name: request.name,
                    runId: "run-1",
                    startedAt: 1,
                    status: "running" as const,
                    taskId: "task-1",
                };
            }),
            stop: vi.fn(),
            wait: vi.fn(),
        };
        const parentMessages: Message[] = [
            {
                blocks: [{ text: "Review the workflow implementation.", type: "text" }],
                id: "user-1",
                role: "user",
            },
            {
                blocks: [],
                id: "agent-1",
                role: "agent",
            },
        ];

        await createWorkflowTool("workflow").execute(
            {
                script: [
                    'agent("Review the implementation.", {"provider": "codex", "model": "openai/gpt-5.6-terra", "effort": "medium", "context": "parent"})',
                ].join("\n"),
            },
            harness.context,
            { messages: parentMessages },
        );

        await launchRequest!.execute({
            onAgentCall: vi.fn(),
            onAgentResult: vi.fn(),
            onCheckpoint: vi.fn(),
            onLog: vi.fn(),
            resumeAgentCalls: [],
            runId: "run-1",
            signal: new AbortController().signal,
        });

        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                contextMessages: [parentMessages[0]],
                contextMode: "parent",
            }),
            expect.any(AbortSignal),
        );
    });
});
