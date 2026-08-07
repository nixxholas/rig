import { describe, expect, it } from "vitest";
import type { Executor } from "@slopus/rig-execution";

import { createNodeAgentContext, type PermissionMode } from "../agent/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createExecutor } from "./createExecutor.js";

function testExecutor(permissionMode: PermissionMode): Executor {
    const context = createNodeAgentContext({
        cwd: "/tmp/rig-executor-server-tools",
        permissionMode,
        processManager: new NativeProcessManager(),
    });
    const result = createExecutor({
        agentContext: context,
        apiKey: "test-api-key",
        env: { XAI_API_KEY: "test-api-key" },
        providers: {
            claude: { enabled: true, type: "claude" },
            codex: { enabled: true, type: "codex" },
            grok: { enabled: true, type: "grok" },
        },
        sessionId: "session-1",
    });
    const executor = result.executor;
    if (executor === undefined) throw new Error("The executor was not built.");
    return executor;
}

describe("createExecutor", () => {
    it("creates one executor containing every enabled configured provider", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext({
                cwd: "/tmp/rig-executor-test",
                processManager: new NativeProcessManager(),
            }),
            apiKey: "test-api-key",
            env: {},
            providers: {
                codex: { enabled: true, type: "codex" },
                disabled_claude: { enabled: false, type: "claude" },
                grok: { enabled: true, type: "grok" },
            },
            sessionId: "session-1",
        });

        expect(result.executor?.providers.map((provider) => provider.id)).toEqual([
            "codex",
            "grok",
        ]);
        expect(result.missingCredentials).toEqual(new Map());
        expect(result.executor?.profiles.map((profile) => profile.id)).toEqual(
            expect.arrayContaining(["openai/gpt-5.6-sol", "xai/grok-build"]),
        );
        expect(result.executor?.environment).toMatchObject({
            osVersion: expect.any(String),
            platform: process.platform,
            primaryWorkingDirectory: "/tmp/rig-executor-test",
            shell: "",
        });

        result.executor?.selectProvider("grok");
        expect(result.executor?.id).toBe("grok");
        expect(result.executor?.models.map((model) => model.id)).toContain("xai/grok-build");
    });

    // Bedrock's hosted search runs on its GPT models, over the Responses endpoint. Its Anthropic
    // models come first in the provider and go over the plain Messages transport, so aiming the
    // search route at the provider's first model would point it at one that cannot search.
    // The model is named rather than taken from the provider's order, so every region where
    // Bedrock offers Web Search answers with the same one.
    it.each(["us-east-1", "us-east-2", "us-west-2"])(
        "routes Bedrock search to the named GPT model in %s",
        (region) => {
            const result = createExecutor({
                agentContext: createNodeAgentContext({
                    cwd: "/tmp/rig-executor-bedrock-search",
                    processManager: new NativeProcessManager(),
                }),
                env: { AWS_BEARER_TOKEN_BEDROCK: "test-bedrock-token" },
                providers: { bedrock: { enabled: true, region, type: "bedrock" } },
                sessionId: "session-1",
            });

            expect(result.searchRoutes.bedrockRoutes.map((route) => route.profile.id)).toEqual([
                "openai/gpt-5.6-luna",
            ]);
        },
    );

    it("searches with the model named in the configuration file", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext({
                cwd: "/tmp/rig-executor-bedrock-search",
                processManager: new NativeProcessManager(),
            }),
            env: { AWS_BEARER_TOKEN_BEDROCK: "test-bedrock-token" },
            providers: {
                bedrock: {
                    enabled: true,
                    region: "us-east-1",
                    searchModelId: "openai/gpt-5.6-terra",
                    type: "bedrock",
                },
            },
            sessionId: "session-1",
        });

        expect(result.searchRoutes.bedrockRoutes.map((route) => route.profile.id)).toEqual([
            "openai/gpt-5.6-terra",
        ]);
    });

    // Silently searching with a different model would answer from somewhere the user did not ask
    // for, which is worse than the tool simply not being offered.
    it("offers no search rather than a substitute when the configured model is unavailable", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext({
                cwd: "/tmp/rig-executor-bedrock-search",
                processManager: new NativeProcessManager(),
            }),
            env: { AWS_BEARER_TOKEN_BEDROCK: "test-bedrock-token" },
            providers: {
                bedrock: {
                    enabled: true,
                    region: "us-east-1",
                    searchModelId: "openai/gpt-5.6-nonexistent",
                    type: "bedrock",
                },
            },
            sessionId: "session-1",
        });

        expect(result.searchRoutes.bedrockRoutes).toEqual([]);
    });

    it("authenticates Bedrock from the configuration file without any environment variable", () => {
        const result = createExecutor({
            agentContext: createNodeAgentContext({
                cwd: "/tmp/rig-executor-bedrock-token",
                processManager: new NativeProcessManager(),
            }),
            env: {},
            providers: {
                bedrock: {
                    bearerToken: "token-from-configuration",
                    enabled: true,
                    region: "us-east-1",
                    type: "bedrock",
                },
            },
            sessionId: "session-1",
        });

        expect(result.missingCredentials).toEqual(new Map());
        expect(result.executor?.providers.map((provider) => provider.id)).toEqual(["bedrock"]);
    });
});
