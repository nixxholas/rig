import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { WorkletContext } from "../../agent/context/WorkletContext.js";
import { defineTool, type AnyDefinedTool } from "../../agent/types.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import type { McpToolProvider } from "../../mcp/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type InferenceStream,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";

describe("InMemorySession MCP permissions", () => {
    it("loads MCP tools in Auto and removes them on downgrade", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/mcp-permissions",
            name: "MCP permissions",
            thinkingLevels: ["off"],
        });
        const toolCatalogs: string[][] = [];
        const provider = defineProvider({
            id: "test",
            models: [model],
            stream(_model, context, options) {
                if (!options?.sessionId?.endsWith(":title")) {
                    toolCatalogs.push(context.tools?.map((tool) => tool.name) ?? []);
                }
                return responseStream();
            },
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: provider.id,
            models: [model],
            providers: [{ providerId: provider.id, models: [model] }],
        };
        const mcpTool = defineTool({
            name: "mcp__trusted__change_state",
            label: "Change state",
            description: "A test MCP tool.",
            arguments: Type.Object({}),
            returnType: Type.Unknown(),
            describeAutoPermissionAction: () =>
                "changing external state. Access: the MCP server can perform actions outside Rig’s filesystem sandbox",
            shouldReviewInAutoMode: () => true,
            execute: () => undefined,
            toLLM: () => [],
            toUI: () => "changed",
            locks: [],
        });
        const refreshedMcpTool = defineTool({
            ...mcpTool,
            label: "Read refreshed state",
            name: "mcp__trusted__read_refreshed_state",
        });
        let activeMcpTools = [mcpTool];
        const release = vi.fn(async () => undefined);
        const load = vi.fn<McpToolProvider["load"]>(async (_cwd, permissionMode) =>
            permissionMode === "auto" || permissionMode === "full_access"
                ? {
                      release,
                      servers: [
                          {
                              name: "trusted",
                              status: "connected",
                              toolCount: activeMcpTools.length,
                          },
                      ],
                      tools: activeMcpTools,
                  }
                : {
                      servers: [
                          {
                              errorMessage: "MCP servers require Full access.",
                              name: "trusted",
                              status: "blocked",
                              toolCount: 0,
                          },
                      ],
                      tools: [],
                  },
        );
        const mcpToolProvider: McpToolProvider = { close: async () => undefined, load };
        let runtime: CodingAssistantRuntime | undefined;
        const session = new InMemorySession({
            createEventId: createEventIdFactory(),
            createRuntime(options) {
                runtime = createRuntime(options, provider);
                return runtime;
            },
            mcpToolProvider,
            modelCatalog: catalog,
            request: {
                cwd: "/tmp/rig-mcp-permission-session",
                modelId: model.id,
                permissionMode: "read_only",
                providerId: provider.id,
            },
        });

        const restrictedRun = session.submit({ text: "Restricted turn." });
        await expect(session.waitForRun(restrictedRun.runId)).resolves.toEqual({
            status: "completed",
        });
        expect(toolCatalogs.at(-1)).not.toContain(mcpTool.name);
        expect(session.snapshot().mcpServers).toEqual([
            expect.objectContaining({ name: "trusted", status: "blocked" }),
        ]);

        await session.changePermissionMode({ permissionMode: "auto" });
        expect(runtime?.agent.tools.map((tool) => tool.name)).not.toContain(mcpTool.name);
        const autoRun = session.submit({ text: "Auto turn." });
        await expect(session.waitForRun(autoRun.runId)).resolves.toEqual({
            status: "completed",
        });
        expect(toolCatalogs.at(-1)).toContain(mcpTool.name);
        expect(session.snapshot().mcpServers).toEqual([
            expect.objectContaining({ name: "trusted", status: "connected" }),
        ]);

        activeMcpTools = [refreshedMcpTool];
        const refreshedRun = session.submit({ text: "Refresh this active session." });
        await expect(session.waitForRun(refreshedRun.runId)).resolves.toEqual({
            status: "completed",
        });
        expect(toolCatalogs.at(-1)).toContain(refreshedMcpTool.name);
        expect(toolCatalogs.at(-1)).not.toContain(mcpTool.name);
        expect(release).toHaveBeenCalledOnce();

        await session.changePermissionMode({ permissionMode: "workspace_write" });
        expect(release).toHaveBeenCalledTimes(2);
        expect(runtime?.agent.tools.map((tool) => tool.name)).not.toContain(mcpTool.name);
        expect(session.snapshot().mcpServers).toEqual([
            expect.objectContaining({ name: "trusted", status: "blocked" }),
        ]);
        const downgradedRun = session.submit({ text: "Downgraded turn." });
        await expect(session.waitForRun(downgradedRun.runId)).resolves.toEqual({
            status: "completed",
        });
        expect(toolCatalogs.at(-1)).not.toContain(mcpTool.name);
        expect(load.mock.calls.map((call) => call[1])).toEqual([
            "read_only",
            "auto",
            "auto",
            "workspace_write",
        ]);
    });

    it("refreshes worklet tools before the next inference in the same run", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "test/live-worklet-tools",
            name: "Live worklet tools",
            thinkingLevels: ["off"],
        });
        let revision = 0;
        const liveTool = defineTool({
            name: "worklet_clock_now",
            label: "Clock now",
            description: "Reads the clock worklet.",
            arguments: Type.Object({}),
            returnType: Type.String(),
            execute: () => "now",
            shouldReviewInAutoMode: () => false,
            toLLM: (value) => [{ text: value, type: "text" }],
            toUI: () => "now",
            locks: [],
        });
        let activeMcpTools: AnyDefinedTool[] = [];
        const installer = defineTool({
            name: "install_clock_worklet",
            label: "Install clock worklet",
            description: "Installs the test worklet.",
            arguments: Type.Object({}),
            returnType: Type.Object({}),
            execute: () => {
                activeMcpTools = [liveTool];
                revision += 1;
                return {};
            },
            shouldReviewInAutoMode: () => false,
            toLLM: () => [{ text: "installed", type: "text" }],
            toUI: () => "installed",
            locks: [],
        });
        const toolCatalogs: string[][] = [];
        let inference = 0;
        const provider = defineProvider({
            id: "test",
            models: [model],
            stream(_model, context, options) {
                if (options?.sessionId?.endsWith(":title")) return responseStream();
                toolCatalogs.push(context.tools?.map((tool) => tool.name) ?? []);
                inference += 1;
                return inference === 1
                    ? responseStream(
                          [
                              {
                                  arguments: {},
                                  id: "install-clock",
                                  name: installer.name,
                                  type: "toolCall",
                              },
                          ],
                          "toolUse",
                      )
                    : responseStream();
            },
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: provider.id,
            models: [model],
            providers: [{ providerId: provider.id, models: [model] }],
        };
        const load = vi.fn<McpToolProvider["load"]>(async () => ({
            servers: [
                {
                    name: "clock",
                    status: "connected",
                    toolCount: activeMcpTools.length,
                },
            ],
            tools: activeMcpTools,
        }));
        const session = new InMemorySession({
            createEventId: createEventIdFactory(),
            createRuntime(options) {
                const runtime = createRuntime(options, provider);
                runtime.agent.context.worklets = {
                    toolRevision: () => revision,
                } as WorkletContext;
                runtime.agent.setTools([installer]);
                return runtime;
            },
            mcpToolProvider: { close: async () => undefined, load },
            modelCatalog: catalog,
            request: {
                cwd: "/tmp/rig-live-worklet-tools",
                modelId: model.id,
                permissionMode: "full_access",
                providerId: provider.id,
            },
        });

        const run = session.submit({ text: "Install the clock and call it." });
        await expect(session.waitForRun(run.runId)).resolves.toEqual({ status: "completed" });

        expect(toolCatalogs).toHaveLength(2);
        expect(toolCatalogs[0]).not.toContain(liveTool.name);
        expect(toolCatalogs[1]).toContain(liveTool.name);
        expect(load).toHaveBeenCalledTimes(2);
    });
});

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({
        cwd: options.cwd,
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
        processManager,
    });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function responseStream(
    content: AssistantMessage["content"] = [{ text: "Done.", type: "text" }],
    stopReason: "length" | "stop" | "toolUse" = "stop",
): InferenceStream {
    const message: AssistantMessage = {
        api: "test",
        content,
        model: "test/mcp-permissions",
        provider: "test",
        role: "assistant",
        stopReason,
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
    return {
        async *[Symbol.asyncIterator]() {
            yield { partial: message, type: "start" as const };
            yield { message, reason: stopReason, type: "done" as const };
        },
        async result() {
            return message;
        },
    };
}
