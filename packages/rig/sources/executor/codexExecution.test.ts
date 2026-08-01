import { describe, expect, it, vi } from "vitest";
import { ExecutorImageGenerationUnavailableError } from "@slopus/rig-execution";
import { CodexImageGenerationError } from "@slopus/rig-providers";

import { codexExecution } from "./codexExecution.js";

describe("codexExecution image generation", () => {
    it("bridges definitive account refusals into safe cross-provider fallback errors", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
                    status: 429,
                }),
            ),
        );
        try {
            const provider = providerDefinition();
            await expect(
                provider.imageGeneration?.generate({
                    prompt: "A lighthouse",
                    turnId: "turn-1",
                }),
            ).rejects.toBeInstanceOf(ExecutorImageGenerationUnavailableError);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("keeps indeterminate server failures terminal instead of trying another account", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: { message: "internal failure" } }), {
                    status: 500,
                }),
            ),
        );
        try {
            const provider = providerDefinition();
            const failed = provider.imageGeneration
                ?.generate({
                    prompt: "A lighthouse",
                    turnId: "turn-1",
                })
                .catch((error: unknown) => error);
            await vi.runAllTimersAsync();
            expect(await failed).toBeInstanceOf(CodexImageGenerationError);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });
});

function providerDefinition() {
    return codexExecution({
        apiKey: "test-key",
        config: {
            baseUrl: "https://example.test/v1",
            enabled: true,
            type: "codex",
        },
        env: {},
        id: "backup-codex",
    });
}
