import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { NativeProcessManager } from "../processes/index.js";
import {
    modelAnthropicFable5,
    modelAnthropicOpus5,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelXaiGrok45,
    modelXaiGrokBuild,
} from "@slopus/rig-execution";
import { createSystemPrompt } from "../agent/prompt/createSystemPrompt.js";
import { toExecutorTool } from "../agent/tools/toExecutorTool.js";
import { createCodingAssistantAgent } from "./createCodingAssistantAgent.js";

describe("createCodingAssistantAgent", () => {
    it("creates a Codex agent with node filesystem and bash contexts", () => {
        const cwd = "/tmp/rig-app-test";
        const processManager = new NativeProcessManager();

        const runtime = createCodingAssistantAgent({
            cwd,
            env: {},
            effort: "medium",
            processManager,
        });

        expect(runtime.cwd).toBe(cwd);
        expect(runtime.processManager).toBe(processManager);
        expect(runtime.executor.id).toBe("codex");
        expect(runtime.agent.model.id).toBe(modelOpenaiGpt56Sol.id);
        expect(runtime.context.fs.cwd).toBe(cwd);
        expect(runtime.context.bash.cwd).toBe(cwd);
        expect(runtime.agent.snapshot().instructions).toContain(cwd);
        expect(runtime.agent.snapshot().effort).toBe("medium");
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "agent_me",
                "agent_info",
                "agent_send",
                "codex_imagegen",
                "get_agent_tree_usage",
            ]),
        );
    });

    it("automatically enables universal Gemini tools from the daemon environment", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { GEMINI_API_KEY: "gemini-key" },
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "gemini_search",
                "gemini_generate_image",
                "gemini_generate_music",
                "gemini_analyze_media",
            ]),
        );
    });

    it("allows same-project delegation without cross-workspace access", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {},
            workspaces: {
                archive: async () => {
                    throw new Error("unused");
                },
                create: async () => {
                    throw new Error("unused");
                },
                crossWorkspace: false,
                delegate: async () => {
                    throw new Error("unused");
                },
                listProjects: () => [],
                listSessions: () => [],
                listWorkspaces: () => [],
                spawn: async () => {
                    throw new Error("unused");
                },
                transfer: async () => {
                    throw new Error("unused");
                },
            },
        });
        const names = runtime.agent.tools.map((tool) => tool.name);

        expect(names).toContain("delegate_to_workspace");
        expect(names).not.toContain("list_projects");
    });

    it("gives the Auto permission reviewer read-only tools and its own permissions", async () => {
        const runtime = createCodingAssistantAgent({
            agentId: "agent-session",
            cwd: "/tmp/rig-app-test",
            env: {},
            permissionMode: "auto",
        });

        const reviewerTools = runtime.agent.tools.filter(
            (tool) => tool.availableToPermissionReviewer,
        );
        expect(reviewerTools.map((tool) => tool.name)).toEqual(["exec_command", "write_stdin"]);
        // The reviewer must never receive a tool that can change the workspace.
        expect(reviewerTools.map((tool) => tool.name)).not.toContain("apply_patch");

        await runtime.agent.close();
    });

    it("creates a Claude SDK agent for Anthropic models", () => {
        const cwd = "/tmp/rig-app-test";
        const processManager = new NativeProcessManager();

        const runtime = createCodingAssistantAgent({
            cwd,
            env: {},
            modelId: modelAnthropicFable5.id,
            processManager,
        });

        expect(runtime.executor.id).toBe("claude");
        expect(runtime.agent.model.id).toBe(modelAnthropicFable5.id);
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual([
            "TaskOutput",
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "TaskCreate",
            "TaskGet",
            "TaskUpdate",
            "TaskList",
            "WebFetch",
            "WebSearch",
            "TaskStop",
            "TaskInput",
            "AskUserQuestion",
            "imagegen",
            "attach",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "webapp_create",
            "webapp_update",
            "webapp_revert",
            "webapp_list",
            "agent_me",
            "agent_info",
            "agent_send",
        ]);
    });

    it.each([
        ["Codex v2", modelOpenaiGpt56Sol.id, {}],
        ["Codex v1", modelOpenaiGpt56Luna.id, {}],
        ["Claude", modelAnthropicFable5.id, {}],
        ["Grok", modelXaiGrokBuild.id, { XAI_API_KEY: "xai-test-key" }],
    ])("gives every %s tool a provider-compatible input schema", (_name, modelId, env) => {
        const runtime = createCodingAssistantAgent({
            chatHistory: {
                read: () => {
                    throw new Error("unused");
                },
            },
            cwd: "/tmp/rig-tool-schema-test",
            env: { ...env, GEMINI_API_KEY: "gemini-key" },
            goals: {
                create: () => {
                    throw new Error("unused");
                },
                get: () => undefined,
                update: () => {
                    throw new Error("unused");
                },
            },
            modelId,
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => {
                    throw new Error("unused");
                },
                interrupt: () => {
                    throw new Error("unused");
                },
                list: () => [],
                maxDepth: 2,
                spawn: async () => {
                    throw new Error("unused");
                },
                wait: async () => ({ agents: [], timedOut: true }),
            },
            workflows: {
                get: () => undefined,
                launch: () => {
                    throw new Error("unused");
                },
                stop: () => undefined,
                wait: async () => undefined,
            },
            workspaces: {
                archive: async () => {
                    throw new Error("unused");
                },
                create: async () => {
                    throw new Error("unused");
                },
                crossWorkspace: true,
                delegate: async () => {
                    throw new Error("unused");
                },
                listProjects: () => [],
                listSessions: () => [],
                listWorkspaces: () => [],
                spawn: async () => {
                    throw new Error("unused");
                },
                transfer: async () => {
                    throw new Error("unused");
                },
            },
        });
        const providerInputSchema = Type.Object(
            { type: Type.Literal("object") },
            { additionalProperties: true },
        );
        const invalidTools = runtime.agent.tools.flatMap((tool) => {
            const definition = toExecutorTool(tool);
            if (definition.kind === "custom") return [];
            return Value.Check(providerInputSchema, definition.parameters) ? [] : [definition.name];
        });

        expect(invalidTools).toEqual([]);
    });

    it("creates a Claude SDK agent for Opus 5", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelAnthropicOpus5.id,
        });

        expect(runtime.executor.id).toBe("claude");
        expect(runtime.agent.model).toEqual(modelAnthropicOpus5);
    });

    it("keeps image generation out of the reserved Responses image tool and namespace", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelOpenaiGpt56Sol.id,
        });

        const names = runtime.agent.tools.map((tool) => tool.name);
        expect(names).toContain("codex_imagegen");
        expect(names).not.toContain("imagegen");
        const imagegen = runtime.agent.tools.find((tool) => tool.name === "codex_imagegen");
        expect(toExecutorTool(imagegen!)).not.toHaveProperty("namespace");
    });

    it("omits image generation when no Codex cloud provider is configured", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {},
            modelId: modelAnthropicFable5.id,
            providers: {
                claude: { enabled: true, type: "claude" },
            },
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).not.toContain("imagegen");
    });

    it("creates a Grok Build agent with the native Grok tool surface", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrokBuild.id,
        });

        expect(runtime.executor.id).toBe("grok");
        expect(runtime.agent.model).toEqual(modelXaiGrokBuild);
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual([
            "run_terminal_command",
            "read_file",
            "search_replace",
            "list_dir",
            "grep",
            "get_command_or_subagent_output",
            "kill_command_or_subagent",
            "send_command_input",
            "imagegen",
            "attach",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "webapp_create",
            "webapp_update",
            "webapp_revert",
            "webapp_list",
            "agent_me",
            "agent_info",
            "agent_send",
        ]);
    });

    it("creates a Grok agent for a curated model", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrok45.id,
        });

        expect(runtime.executor.id).toBe("grok");
        expect(runtime.agent.model).toEqual(modelXaiGrok45);
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("run_terminal_command");
    });

    it("creates agents for named provider instances and applies their model filters", () => {
        const providers = {
            work_codex: {
                authFile: "/tmp/codex-work-auth.json",
                enabled: true,
                includeModels: [modelOpenaiGpt56Sol.id],
                type: "codex" as const,
            },
            work_claude: {
                configDir: "/tmp/claude-work",
                enabled: true,
                includeModels: [modelAnthropicFable5.id],
                type: "claude" as const,
            },
        };

        const codex = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "work_codex",
            providers,
        });
        const claude = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
            providerId: "work_claude",
            providers,
        });

        expect(codex.executor.id).toBe("work_codex");
        expect(codex.executor.models).toEqual([modelOpenaiGpt56Sol]);
        expect(claude.executor.id).toBe("work_claude");
        expect(claude.executor.models).toEqual([modelAnthropicFable5]);
    });

    it("rejects disabled provider instances", () => {
        expect(() =>
            createCodingAssistantAgent({
                cwd: "/tmp/rig-app-test",
                providerId: "codex",
                providers: {
                    codex: { enabled: false, type: "codex" },
                },
            }),
        ).toThrow("Unknown or disabled inference provider 'codex'.");
    });

    it("rejects an explicitly selected provider whose filters remove every model", () => {
        expect(() =>
            createCodingAssistantAgent({
                cwd: "/tmp/rig-app-test",
                modelId: modelOpenaiGpt56Sol.id,
                providerId: "work_codex",
                providers: {
                    work_codex: {
                        enabled: true,
                        excludeModels: [modelOpenaiGpt56Sol.id],
                        includeModels: [modelOpenaiGpt56Sol.id],
                        type: "codex",
                    },
                },
            }),
        ).toThrow("Provider 'work_codex' has no models after applying its model filters.");
    });

    it("does not fall back to the default Bedrock credential for a named instance", () => {
        expect(() =>
            createCodingAssistantAgent({
                cwd: "/tmp/rig-app-test",
                env: { AWS_BEARER_TOKEN_BEDROCK: "default-token" },
                modelId: modelOpenaiGpt56Sol.id,
                providerId: "work_bedrock",
                providers: {
                    work_bedrock: {
                        bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                        enabled: true,
                        type: "bedrock",
                    },
                },
            }),
        ).toThrow(
            "Inference provider 'work_bedrock' requires the WORK_BEDROCK_TOKEN environment variable.",
        );
    });

    it("applies a Bedrock model-specific region override", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { WORK_BEDROCK_TOKEN: "work-token" },
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "work_bedrock",
            providers: {
                work_bedrock: {
                    bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                    enabled: true,
                    modelOverrides: {
                        [modelOpenaiGpt56Sol.id]: { region: "us-east-1" },
                    },
                    region: "us-west-2",
                    type: "bedrock",
                },
            },
        });

        expect(runtime.executor.models.map((model) => model.id)).toContain(modelOpenaiGpt56Sol.id);
    });

    it("allows a Bedrock endpoint override to bypass regional availability", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { WORK_BEDROCK_TOKEN: "work-token" },
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "work_bedrock",
            providers: {
                work_bedrock: {
                    bearerTokenEnvVar: "WORK_BEDROCK_TOKEN",
                    enabled: true,
                    modelOverrides: {
                        [modelOpenaiGpt56Sol.id]: {
                            endpoint: "https://mantle.example/openai/v1",
                        },
                    },
                    region: "us-west-2",
                    type: "bedrock",
                },
            },
        });

        expect(runtime.executor.models.map((model) => model.id)).toContain(modelOpenaiGpt56Sol.id);
    });

    it("adds provider-neutral goal tools when the session supports goals", () => {
        const currentGoal = {
            createdAt: 1,
            objective: "Finish the feature",
            status: "active" as const,
            updatedAt: 1,
        };
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            goals: {
                create: () => currentGoal,
                get: () => currentGoal,
                update: (status) => ({ ...currentGoal, status }),
            },
            modelId: modelAnthropicFable5.id,
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["create_goal", "get_goal", "update_goal"]),
        );
    });

    it("assembles a flat Codex tool list", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => {
                    throw new Error("not used");
                },
                interrupt: () => {
                    throw new Error("not used");
                },
                list: () => [],
                maxDepth: 3,
                spawn: async () => {
                    throw new Error("not used");
                },
                wait: async () => ({ agents: [], timedOut: false }),
            },
            workflows: {
                get: () => undefined,
                launch: () => {
                    throw new Error("not used");
                },
                stop: () => undefined,
                wait: async () => undefined,
            },
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "workflow",
                "wait_for_workflow",
                "workflow_status",
                "stop_workflow",
                "spawn_agent",
                "followup_task",
                "send_message",
                "wait_agent",
                "list_agents",
                "interrupt_agent",
            ]),
        );
        expect(
            runtime.agent.tools
                .filter((tool) => tool.namespace?.name === "collaboration")
                .map((tool) => tool.name),
        ).toEqual([
            "spawn_agent",
            "followup_task",
            "send_message",
            "wait_agent",
            "list_agents",
            "interrupt_agent",
        ]);
        expect(
            runtime.agent.tools
                .filter((tool) => tool.namespace?.name === "collaboration_ext")
                .map((tool) => tool.name),
        ).toEqual(["spawn_agent", "followup_task"]);
    });

    it("exposes the Agent tool only while another nested level is available", () => {
        const spawn = async () => ({
            agentId: "test-agent",
            output: "done",
            path: "/root/test",
            sessionId: "subagent-1",
            status: "completed" as const,
            taskName: "test",
        });
        const controls = {
            depth: 0,
            followUp: () => {
                throw new Error("not used");
            },
            interrupt: () => {
                throw new Error("not used");
            },
            list: () => [],
            maxDepth: 3,
            spawn,
            wait: async () => ({ agents: [], timedOut: false }),
        };
        const workflows = {
            get: () => undefined,
            launch: () => {
                throw new Error("not used");
            },
            stop: () => undefined,
            wait: async () => undefined,
        };
        const parent = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            subagents: { ...controls, canSpawn: true },
            workflows,
        });
        const deepest = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            subagents: { ...controls, canSpawn: false, depth: 3 },
        });

        expect(parent.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "exec_command",
                "write_stdin",
                "update_plan",
                "request_user_input",
                "apply_patch",
                "view_image",
                "workflow",
                "spawn_agent",
            ]),
        );
        expect(deepest.agent.tools.map((tool) => tool.name)).not.toContain("spawn_agent");
        expect(deepest.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
                "followup_task",
                "wait_agent",
                "list_agents",
                "interrupt_agent",
                "send_message",
            ]),
        );
        expect(deepest.agent.tools.map((tool) => tool.name)).not.toContain("workflow");

        const claudeParent = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
            subagents: { ...controls, canSpawn: true },
            workflows,
        });
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("Agent");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("SendMessage");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("Workflow");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).toContain("WaitForWorkflow");
        expect(claudeParent.agent.tools.map((tool) => tool.name)).not.toContain("spawn_agent");

        const claudeDeepest = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelAnthropicFable5.id,
            subagents: { ...controls, canSpawn: false, depth: 3 },
            workflows,
        });
        expect(claudeDeepest.agent.tools.map((tool) => tool.name)).toContain("SendMessage");
        expect(claudeDeepest.agent.tools.map((tool) => tool.name)).not.toContain("Agent");
        expect(claudeDeepest.agent.tools.map((tool) => tool.name)).not.toContain("Workflow");

        const grokParent = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrok45.id,
            subagents: { ...controls, canSpawn: true },
        });
        expect(grokParent.agent.tools.map((tool) => tool.name)).toContain("spawn_subagent");
        expect(grokParent.agent.tools.map((tool) => tool.name)).toContain("followup_subagent");

        const grokDeepest = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: { XAI_API_KEY: "xai-test-key" },
            modelId: modelXaiGrok45.id,
            subagents: { ...controls, canSpawn: false, depth: 3 },
        });
        expect(grokDeepest.agent.tools.map((tool) => tool.name)).toContain("followup_subagent");
        expect(grokDeepest.agent.tools.map((tool) => tool.name)).not.toContain("spawn_subagent");
    });

    it("explicitly permits parent delegation for every provider", async () => {
        const controls = {
            canSpawn: true,
            depth: 0,
            followUp: () => {
                throw new Error("not used");
            },
            interrupt: () => {
                throw new Error("not used");
            },
            list: () => [],
            maxDepth: 3,
            spawn: async () => {
                throw new Error("not used");
            },
            wait: async () => ({ agents: [], timedOut: false }),
        };
        const runtimes = [
            createCodingAssistantAgent({
                cwd: "/tmp/rig-app-test",
                modelId: modelOpenaiGpt56Sol.id,
                subagents: controls,
            }),
            createCodingAssistantAgent({
                cwd: "/tmp/rig-app-test",
                modelId: modelAnthropicFable5.id,
                subagents: controls,
            }),
            createCodingAssistantAgent({
                cwd: "/tmp/rig-app-test",
                env: { XAI_API_KEY: "xai-test-key" },
                modelId: modelXaiGrok45.id,
                subagents: controls,
            }),
        ];

        for (const runtime of runtimes) {
            const prompt = await createSystemPrompt({
                context: runtime.context,
                messages: [],
                model: runtime.agent.model,
                provider: runtime.executor,
                tools: runtime.agent.tools,
            });

            expect(prompt).toContain("You are the parent agent");
            expect(prompt).toContain("explicitly allowed to spawn subagents");
        }
    });

    it("explains workspace isolation only when workspace tools are present", async () => {
        const workspaces = {
            archive: async () => {
                throw new Error("unused");
            },
            create: async () => {
                throw new Error("unused");
            },
            crossWorkspace: false,
            delegate: async () => {
                throw new Error("unused");
            },
            listProjects: () => [],
            listSessions: () => [],
            listWorkspaces: () => [],
            spawn: async () => {
                throw new Error("unused");
            },
            transfer: async () => {
                throw new Error("unused");
            },
        };
        const withWorkspaces = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {},
            workspaces,
        });
        const withoutWorkspaces = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {},
        });

        const promptWith = await createSystemPrompt({
            context: withWorkspaces.context,
            messages: [],
            model: withWorkspaces.agent.model,
            provider: withWorkspaces.executor,
            tools: withWorkspaces.agent.tools,
        });
        const promptWithout = await createSystemPrompt({
            context: withoutWorkspaces.context,
            messages: [],
            model: withoutWorkspaces.agent.model,
            provider: withoutWorkspaces.executor,
            tools: withoutWorkspaces.agent.tools,
        });

        expect(promptWith).toContain("# Workspaces");
        expect(promptWith).toContain("parallel tasks each get their own fresh workspace");
        expect(promptWithout).not.toContain("# Workspaces");
    });

    it("keeps V2 child guidance at maximum depth and excludes Luna", async () => {
        const managed = {
            agentId: "test-agent",
            description: "Test",
            path: "/root/test",
            sessionId: "test",
            status: "completed" as const,
            taskName: "test",
        };
        const controls = {
            depth: 3,
            followUp: () => managed,
            interrupt: () => managed,
            list: () => [managed],
            maxActive: 4,
            maxDepth: 3,
            sendMessage: () => managed,
            spawn: async () => ({ ...managed, output: "done" }),
            wait: async () => ({ agents: [managed], timedOut: false }),
        };
        const deepest = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Sol.id,
            subagents: { ...controls, canSpawn: false },
        });
        const luna = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            modelId: modelOpenaiGpt56Luna.id,
            subagents: { ...controls, canSpawn: true, depth: 0 },
        });

        const deepestPrompt = await createSystemPrompt({
            context: deepest.context,
            messages: [],
            model: deepest.agent.model,
            provider: deepest.executor,
            tools: deepest.agent.tools,
        });
        const lunaPrompt = await createSystemPrompt({
            context: luna.context,
            messages: [],
            model: luna.agent.model,
            provider: luna.executor,
            tools: luna.agent.tools,
        });

        expect(deepestPrompt).toContain("immediately delivered back to your parent agent");
        expect(deepestPrompt).toContain("cannot spawn additional sub-agents at this depth");
        expect(deepestPrompt).not.toContain("`spawn_agent`");
        expect(lunaPrompt).not.toContain("immediately delivered back to your parent agent");
        expect(luna.agent.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["close_agent", "resume_agent", "send_input"]),
        );
        expect(luna.agent.tools.map((tool) => tool.name)).not.toContain("followup_task");
    });

    it("omits workflow tools when workflow support is disabled", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => {
                    throw new Error("not used");
                },
                interrupt: () => {
                    throw new Error("not used");
                },
                list: () => [],
                maxDepth: 3,
                spawn: async () => {
                    throw new Error("not used");
                },
                wait: async () => ({ agents: [], timedOut: false }),
            },
            workflows: {
                get: () => undefined,
                launch: () => {
                    throw new Error("not used");
                },
                stop: () => undefined,
                wait: async () => undefined,
            },
            workflowsEnabled: false,
        });

        expect(runtime.agent.tools.map((tool) => tool.name)).not.toEqual(
            expect.arrayContaining([
                "workflow",
                "wait_for_workflow",
                "workflow_status",
                "stop_workflow",
            ]),
        );
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("spawn_agent");
    });

    it("creates an Amazon Bedrock agent for Bedrock Anthropic models", () => {
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
            modelId: modelAnthropicFable5.id,
            providerId: "bedrock",
        });

        expect(runtime.executor.id).toBe("bedrock");
        expect(runtime.agent.model.id).toBe(modelAnthropicFable5.id);
        expect(runtime.agent.tools.map((tool) => tool.name)).toContain("Bash");
    });

    it("uses plaintext multi-agent v1 tools for Bedrock OpenAI models", () => {
        const managed = {
            agentId: "test-agent",
            description: "Test",
            path: "/root/test",
            sessionId: "test",
            status: "completed" as const,
            taskName: "test",
        };
        const runtime = createCodingAssistantAgent({
            cwd: "/tmp/rig-app-test",
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
                AWS_REGION: "us-east-1",
            },
            modelId: modelOpenaiGpt56Sol.id,
            providerId: "bedrock",
            subagents: {
                canSpawn: true,
                depth: 0,
                followUp: () => managed,
                interrupt: () => managed,
                list: () => [managed],
                maxDepth: 3,
                spawn: async () => ({ ...managed, output: "done" }),
                wait: async () => ({ agents: [managed], timedOut: false }),
            },
        });

        expect(runtime.executor.id).toBe("bedrock");
        expect(runtime.agent.model.id).toBe(modelOpenaiGpt56Sol.id);
        expect(
            runtime.agent.tools
                .filter((tool) => tool.namespace?.name === "multi_agent_v1")
                .map((tool) => tool.name),
        ).toEqual(["close_agent", "resume_agent", "send_input", "spawn_agent", "wait_agent"]);
        expect(runtime.agent.tools.map((tool) => tool.name)).toEqual([
            "exec_command",
            "write_stdin",
            "kill_session",
            "update_plan",
            "request_user_input",
            "apply_patch",
            "view_image",
            "codex_imagegen",
            "attach",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "webapp_create",
            "webapp_update",
            "webapp_revert",
            "webapp_list",
            "agent_me",
            "agent_info",
            "agent_send",
            "close_agent",
            "resume_agent",
            "send_input",
            "spawn_agent",
            "wait_agent",
        ]);
    });
});
