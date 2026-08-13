/**
 * Curated model catalog for rig defaults.
 *
 * Order matches the Conductor model picker.
 */

/** Model metadata exposed by a provider. */
export interface Model<TThinkingLevel extends string = string> {
    id: string;
    name: string;
    thinkingLevels: readonly TThinkingLevel[];
    defaultThinkingLevel: TThinkingLevel;
    /** Maximum input context accepted by the model. */
    contextWindow?: number;
    /** Smaller effective window used to decide when automatic compaction begins. */
    autoCompactWindow?: number;
}

/** Statically typed helper for constructing a model definition. */
function defineModel<const TThinkingLevel extends string>(model: {
    id: string;
    name: string;
    thinkingLevels: readonly TThinkingLevel[];
    defaultThinkingLevel: TThinkingLevel;
    contextWindow?: number;
    autoCompactWindow?: number;
}): Model<TThinkingLevel> {
    return model;
}

export const modelAnthropicFable5 = defineModel({
    id: "anthropic/fable-5",
    name: "Fable 5",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicOpus5 = defineModel({
    id: "anthropic/opus-5",
    name: "Opus 5 1M",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicOpus48 = defineModel({
    id: "anthropic/opus-4-8",
    name: "Opus 4.8 1M",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicOpus47 = defineModel({
    id: "anthropic/opus-4-7",
    name: "Opus 4.7 1M",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicOpus46 = defineModel({
    id: "anthropic/opus-4-6",
    name: "Opus 4.6 1M",
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicSonnet5 = defineModel({
    id: "anthropic/sonnet-5",
    name: "Sonnet 5",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicSonnet461m = defineModel({
    id: "anthropic/sonnet-4-6-1m",
    name: "Sonnet 4.6 1M",
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    defaultThinkingLevel: "medium",
    contextWindow: 1_000_000,
    autoCompactWindow: 333_000,
});

export const modelAnthropicSonnet46 = defineModel({
    id: "anthropic/sonnet-4-6",
    name: "Sonnet 4.6",
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    defaultThinkingLevel: "medium",
    contextWindow: 200_000,
});

export const modelAnthropicHaiku45 = defineModel({
    id: "anthropic/haiku-4-5",
    name: "Haiku 4.5",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
    contextWindow: 200_000,
});

export const modelOpenaiGpt55 = defineModel({
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    defaultThinkingLevel: "medium",
    contextWindow: 272_000,
});

export const modelOpenaiGpt56Sol = defineModel({
    id: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 372_000,
});

export const modelOpenaiGpt56Terra = defineModel({
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
    defaultThinkingLevel: "medium",
    contextWindow: 372_000,
});

export const modelOpenaiGpt56Luna = defineModel({
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "medium",
    contextWindow: 372_000,
});

export const modelOpenaiGpt54 = defineModel({
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    defaultThinkingLevel: "medium",
    contextWindow: 272_000,
});

/**
 * Reviews one proposed action for Auto permissions. It never appears in the model picker and is
 * never used for ordinary inference, so it is deliberately absent from the profile catalog.
 */
export const modelOpenaiCodexAutoReview = defineModel({
    id: "openai/codex-auto-review",
    name: "Codex Auto Review",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    defaultThinkingLevel: "low",
    contextWindow: 272_000,
});

export const modelXaiGrokBuild = defineModel({
    id: "xai/grok-build",
    name: "Grok Build",
    thinkingLevels: ["on"],
    defaultThinkingLevel: "on",
    contextWindow: 500_000,
});

export const modelXaiGrok45 = defineModel({
    id: "xai/grok-4.5",
    name: "Grok 4.5",
    thinkingLevels: ["low", "medium", "high"],
    defaultThinkingLevel: "high",
    contextWindow: 500_000,
});

export const modelXaiGrokComposer25Fast = defineModel({
    id: "xai/grok-composer-2.5-fast",
    name: "Composer 2.5",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
    contextWindow: 200_000,
});

/** Every model definition in the catalog, in picker order. */
export const knownModels: readonly Model[] = [
    modelAnthropicFable5,
    modelAnthropicOpus5,
    modelAnthropicOpus48,
    modelAnthropicOpus47,
    modelAnthropicOpus46,
    modelAnthropicSonnet5,
    modelAnthropicSonnet461m,
    modelAnthropicSonnet46,
    modelAnthropicHaiku45,
    modelOpenaiGpt55,
    modelOpenaiGpt56Sol,
    modelOpenaiGpt56Terra,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt54,
    modelOpenaiCodexAutoReview,
    modelXaiGrokBuild,
    modelXaiGrok45,
    modelXaiGrokComposer25Fast,
];
