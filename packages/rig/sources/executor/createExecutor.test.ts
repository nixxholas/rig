import type { ProviderQuota } from "@slopus/rig-providers";
import { describe, expect, it, vi } from "vitest";

import { createNodeAgentContext } from "../agent/index.js";
import { NativeProcessManager } from "../processes/index.js";
import { createExecutor } from "./createExecutor.js";

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

    it("routes Claude session quota reads through the daemon-owned loader", async () => {
        const quota: ProviderQuota = {
            capturedAt: 1,
            source: "claude",
            windows: {
                fiveHour: { status: "unavailable" },
                weekly: { status: "unavailable" },
            },
        };
        const loadProviderQuota = vi.fn(async () => quota);
        const result = createExecutor({
            agentContext: createNodeAgentContext({
                cwd: "/tmp/rig-executor-test",
                processManager: new NativeProcessManager(),
            }),
            env: {},
            loadProviderQuota,
            providers: {
                claude: { enabled: true, type: "claude" },
            },
        });

        result.executor?.selectProvider("claude");
        await expect(result.executor?.quota?.({ fresh: true })).resolves.toBe(quota);
        expect(loadProviderQuota).toHaveBeenCalledWith("claude", { fresh: true });
    });
});
