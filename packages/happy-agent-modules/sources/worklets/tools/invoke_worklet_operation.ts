import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletInvocationInputSchema,
    workletInvocationResultSchema,
    type WorkletInvocationInput,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

export function invokeWorkletOperationTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "invoke_worklet_operation",
        description:
            "Invoke one operation declared by a worklet with bounded JSON arguments. The host owns wake/sleep and runtime execution.",
        parameters: workletInvocationInputSchema,
        returnType: workletInvocationResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkletInvocationInput) =>
            await module.invokeOperation(ctx, agentId, input),
        toLLM: (result) => [
            {
                type: "text",
                text: module.formatInvocationForModel(result),
            },
        ],
    });
}
