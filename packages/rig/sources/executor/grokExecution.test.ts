import { describe, expect, it } from "vitest";

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
});
