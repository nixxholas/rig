import { Type } from "@sinclair/typebox";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import {
    defineAgentTool,
    knownModels,
    type AgentFeature,
    type AgentModel,
} from "../../sources/index.js";
import type { RealGymVendor } from "./loadRealProvider.js";

/**
 * The gym's own feature: it tells the model it is being exercised by an automated check, and
 * gives it one real tool, so a scenario can prove a tool call travels the whole way — model to
 * agent to execution and back into the conversation.
 */
export class FeatureGymHarness implements AgentFeature {
    readonly name = "gym";

    /** Every answer the model recorded through the tool, in call order. */
    readonly recorded: string[] = [];

    readonly recordAnswerTool = defineAgentTool({
        name: "record_answer",
        description:
            "Record an answer with the automated check that is exercising you. Call it only when you are explicitly asked to record an answer, exactly once, and then stop.",
        parameters: Type.Object(
            {
                answer: Type.String({
                    minLength: 1,
                    maxLength: 200,
                    description: "The answer itself, with no explanation around it.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ recorded: Type.String() }),
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: (_ctx: Context, { answer }) => {
            this.recorded.push(answer);
            return Promise.resolve({ recorded: answer });
        },
        toLLM: ({ recorded }) => [
            { type: "text", text: `Recorded "${recorded}". The check is finished; stop now.` },
        ],
    });

    readonly tools = () => [this.recordAnswerTool] as const;

    readonly instructions = (): string =>
        [
            "# Automated check",
            "An automated check is exercising you. Answer exactly what is asked, in as few words as possible, and never ask a follow-up question.",
            "Do not start subagents; answer directly yourself.",
            "Use a tool only when you are explicitly asked to; otherwise just reply in text.",
        ].join("\n");
}

/**
 * The feature classes every gym agent runs with, named as the report lists them. One instance of
 * each serves every agent the gym's collection builds.
 */
export const REAL_GYM_FEATURES: readonly {
    name: string;
    Feature: new () => AgentFeature;
}[] = [{ name: "gym", Feature: FeatureGymHarness }];

const EFFORTS: readonly SessionReasoningEffort[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

/**
 * The catalog the gym's collection offers, drawn from the curated `knownModels` and narrowed to
 * the vendor actually signed in, so the models section of the prompt names routes that exist.
 */
export function realGymModels(vendor: RealGymVendor): readonly AgentModel[] {
    const prefix = vendor === "codex" ? "openai/" : "anthropic/";
    return knownModels
        .filter((model) => model.id.startsWith(prefix))
        .map((model) => ({
            providerId: vendor,
            id: model.id,
            name: model.name,
            effortLevels: model.thinkingLevels.filter((level): level is SessionReasoningEffort =>
                EFFORTS.includes(level as SessionReasoningEffort),
            ),
            defaultEffort: effortOf(model.defaultThinkingLevel),
            ...(vendor === "codex" ? { serviceTiers: ["priority" as const] } : {}),
        }));
}

function effortOf(thinkingLevel: string): SessionReasoningEffort {
    if (thinkingLevel === "ultra") return "max";
    return EFFORTS.includes(thinkingLevel as SessionReasoningEffort)
        ? (thinkingLevel as SessionReasoningEffort)
        : "medium";
}
