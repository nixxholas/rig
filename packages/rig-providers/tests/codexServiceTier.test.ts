import { describe, expect, it } from "vitest";

import { createCodexBedrockRequest } from "@/vendors/codex/impl/createCodexBedrockRequest.js";
import { createCodexCliRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";

describe("Codex service tier", () => {
    it("writes the priority tier to the native request", () => {
        const request = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Test", messages: [] },
            effort: "low",
            model: "gpt-5.6-sol",
            promptCacheKey: "session",
            serviceTier: "priority",
            tools: [],
        });

        expect(request.service_tier).toBe("priority");
    });

    it("drops the tier on Bedrock, which only offers the implicit default tier", () => {
        const request = createCodexCliRequest({
            clientMetadata: {},
            context: { instructions: "Test", messages: [] },
            effort: "low",
            model: "openai.gpt-5.6-sol",
            promptCacheKey: "session",
            serviceTier: "priority",
            tools: [],
        });

        expect(createCodexBedrockRequest(request).service_tier).toBeUndefined();
    });
});
