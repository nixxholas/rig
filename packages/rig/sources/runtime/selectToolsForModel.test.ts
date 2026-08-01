import { describe, expect, it } from "vitest";

import { selectToolsForModel } from "./selectToolsForModel.js";
import { modelAnthropicSonnet46, modelXaiGrokBuild } from "@slopus/rig-execution";
import { defineProvider } from "@slopus/rig-execution";
import { grokBuildTools } from "../tools/grok/index.js";

describe("selectToolsForModel", () => {
    it("selects the Grok tool surface for Grok models", () => {
        const provider = defineProvider({
            id: "custom-xai-provider",
            models: [modelXaiGrokBuild],
            type: "grok",
            stream: () => {
                throw new Error("Inference is not used by this test.");
            },
        });

        expect(selectToolsForModel({ model: modelXaiGrokBuild, provider })).toEqual(grokBuildTools);
    });

    it("names the image tool for each model family and never duplicates it", () => {
        const imageGeneration = [
            {
                id: "codex",
                imageGeneration: { generate: () => Promise.reject(new Error("unused")) },
            },
        ];

        const named = (toolProfile: "claude" | "codex" | "grok") =>
            selectToolsForModel({
                imageGeneration,
                model: modelXaiGrokBuild,
                provider: providerWithToolProfile(toolProfile),
            })
                .map((tool) => tool.name)
                .filter((name) => name.endsWith("imagegen"));

        expect(named("codex")).toEqual(["codex_imagegen"]);
        expect(named("claude")).toEqual(["imagegen"]);
        expect(named("grok")).toEqual(["imagegen"]);
    });

    it("omits the image tool when no provider can generate images", () => {
        const tools = selectToolsForModel({
            imageGeneration: [],
            model: modelXaiGrokBuild,
            provider: providerWithToolProfile("codex"),
        });

        expect(tools.map((tool) => tool.name)).not.toContain("codex_imagegen");
    });

    it("keeps WebFetch but omits unsupported WebSearch for Bedrock Claude models", () => {
        const tools = selectToolsForModel({
            model: modelAnthropicSonnet46,
            provider: {
                id: "bedrock",
                type: "bedrock",
                models: [modelAnthropicSonnet46],
                serviceTiers: undefined,
                extendProfilePromptContext: undefined,
                stream: () => {
                    throw new Error("Not used");
                },
            },
        });

        expect(tools.map((tool) => tool.name)).toContain("WebFetch");
        expect(tools.map((tool) => tool.name)).not.toContain("WebSearch");
    });

    it("adds every universal Gemini tool to every provider-owned tool profile", () => {
        for (const toolProfile of ["claude", "codex", "grok"] as const) {
            const provider = providerWithToolProfile(toolProfile);

            const tools = selectToolsForModel({
                geminiApiKey: "gemini-key",
                model: modelXaiGrokBuild,
                provider,
            });

            expect(tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                    "gemini_search",
                    "gemini_generate_image",
                    "gemini_generate_music",
                    "gemini_analyze_media",
                ]),
            );
            if (toolProfile === "claude") {
                expect(tools.filter((tool) => tool.name === "WebSearch")).toHaveLength(1);
            }
        }
    });
});

function providerWithToolProfile(toolProfile: "claude" | "codex" | "grok") {
    return defineProvider({
        id: `${toolProfile}-compatible-provider`,
        models: [modelXaiGrokBuild],
        type: toolProfile,
        stream: () => {
            throw new Error("Inference is not used by this test.");
        },
    });
}
