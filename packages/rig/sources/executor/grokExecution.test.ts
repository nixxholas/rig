import { describe, expect, it } from "vitest";
import { GrokProvider } from "@slopus/happy-providers";

import { grokExecution } from "./grokExecution.js";

const env = { XAI_API_KEY: "test-api-key" } satisfies NodeJS.ProcessEnv;

describe("grokExecution", () => {
    it("builds a Grok provider definition with the Grok catalog", () => {
        const definition = grokExecution({
            config: { enabled: true, type: "grok" },
            env,
            id: "grok",
        });
        expect(definition.id).toBe("grok");
        expect(definition.profiles.some((profile) => profile.id === "xai/grok-4.5")).toBe(true);
        // No separate serverTools catalog: server tools are declared on the inference tool list.
        expect(definition).not.toHaveProperty("serverTools");
    });

    it("can be isolated without a second capability registry", () => {
        const definition = grokExecution({
            config: { enabled: true, type: "grok" },
            env,
            id: "grok",
        });
        expect(definition.isolated?.()).toBe(definition);
    });

    it("uses a provisioned API key instead of an ambient credential", async () => {
        const definition = grokExecution({
            config: { apiKey: "provisioned-key", enabled: true, type: "grok" },
            env,
            id: "grok",
        });
        if (typeof definition.native !== "function") expect.fail("Expected a lazy Grok provider.");
        const profile = definition.profiles[0];
        if (profile === undefined) expect.fail("Expected a Grok model profile.");

        const provider = await definition.native(profile);

        expect(provider).toBeInstanceOf(GrokProvider);
        expect((provider as GrokProvider).credential).toMatchObject({
            credential: { token: "provisioned-key" },
            name: "grok-api-key",
        });
    });
});
