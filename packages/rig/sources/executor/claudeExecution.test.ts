import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@slopus/happy-providers";

import { claudeExecution } from "./claudeExecution.js";

describe("claudeExecution", () => {
    it.each([
        {
            config: { apiKey: "provisioned-api-key", enabled: true, type: "claude" as const },
            expected: { credential: { apiKey: "provisioned-api-key" }, name: "claude-api-key" },
        },
        {
            config: { authToken: "provisioned-auth-token", enabled: true, type: "claude" as const },
            expected: {
                credential: { authToken: "provisioned-auth-token" },
                name: "claude-auth-token",
            },
        },
    ])("uses explicit imported authentication for $expected.name", async ({ config, expected }) => {
        const definition = claudeExecution({ config, env: {}, id: "claude" });
        if (typeof definition.native !== "function")
            expect.fail("Expected a lazy Claude provider.");
        const profile = definition.profiles[0];
        if (profile === undefined) expect.fail("Expected a Claude model profile.");
        const provider = await definition.native(profile);

        expect(provider).toBeInstanceOf(AnthropicProvider);
        expect((provider as AnthropicProvider).credential).toMatchObject(expected);
    });
});
