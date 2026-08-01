import type { AnyDefinedTool } from "../agent/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import { claudeTools } from "../agent/tools/claude/assembleClaudeTools.js";
import { assembleCodexTools } from "../agent/tools/codex/assembleCodexTools.js";
import { codexCollaborationTools } from "../agent/tools/codex/assembleCodexTools.js";
import { grokBuildTools } from "../tools/grok/index.js";
import { createGeminiTools } from "../tools/gemini/createGeminiTools.js";
import {
    createImageGenerationTool,
    type ImageGenerationProvider,
} from "../tools/imageGeneration/createImageGenerationTool.js";
import {
    codexImageGenerationSurface,
    imageGenerationSurface,
} from "../tools/imageGeneration/imageGenerationSurfaces.js";

export interface SelectToolsForModelOptions {
    geminiApiKey?: string;
    imageGeneration?: readonly ImageGenerationProvider[];
    provider: Provider;
    model: Model;
}

export function selectToolsForModel(
    options: SelectToolsForModelOptions,
): readonly AnyDefinedTool[] {
    const toolType =
        options.provider.type === "bedrock"
            ? options.model.id.startsWith("anthropic/")
                ? "claude"
                : "codex"
            : options.provider.type;
    const vendor = toolType === "claude" ? "claude" : toolType === "grok" ? "grok" : "codex";
    const collaborationNames = new Set(codexCollaborationTools.map((tool) => tool.name));
    const baseTools =
        vendor === "claude"
            ? claudeTools
            : vendor === "grok"
              ? grokBuildTools
              : assembleCodexTools(
                    options.model.id,
                    options.provider.type ?? options.provider.id,
                ).filter((tool) => !collaborationNames.has(tool.name));
    const providerTools =
        options.provider.type === "bedrock"
            ? baseTools.filter((tool) => tool.name !== "WebSearch")
            : baseTools;
    return [
        ...providerTools,
        ...(options.geminiApiKey === undefined ? [] : createGeminiTools(options.geminiApiKey)),
        ...imageGenerationTools(options.imageGeneration ?? [], vendor),
    ];
}

/**
 * Image generation is one Rig capability behind a vendor-shaped surface: Codex models get the
 * name and guidance their training expects, and every other family gets Rig's plain wording.
 */
function imageGenerationTools(
    providers: readonly ImageGenerationProvider[],
    vendor: "claude" | "codex" | "grok",
): readonly AnyDefinedTool[] {
    if (providers.length === 0) return [];
    return [
        createImageGenerationTool(
            providers,
            vendor === "codex" ? codexImageGenerationSurface : imageGenerationSurface,
        ),
    ];
}
