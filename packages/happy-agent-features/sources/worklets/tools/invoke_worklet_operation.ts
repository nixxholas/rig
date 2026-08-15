import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletInvocationInputSchema,
    workletInvocationResultSchema,
    type WorkletInvocationInput,
} from "../Worklet.js";
import type { WorkletsFeature } from "../WorkletsFeature.js";

export function invokeWorkletOperationTool(feature: WorkletsFeature, agentId: string) {
    return defineAgentTool({
        name: "invoke_worklet_operation",
        description:
            "Invoke one operation declared by a worklet with bounded JSON arguments. The host owns wake/sleep and runtime execution.",
        parameters: workletInvocationInputSchema,
        returnType: workletInvocationResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkletInvocationInput) =>
            await feature.invokeOperation(ctx, agentId, input),
        toLLM: (result) => [
            {
                type: "text",
                text: feature.formatInvocationForModel(result),
            },
        ],
    });
}