import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletSchema,
    workletToolInstallInputSchema,
    type WorkletToolInstallInput,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

export function installWorkletTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "install_worklet",
        description:
            "Install a TypeScript worklet from an absolute path to its source folder. Rig verifies the folder and copies it in as version 1, creating the worklet's durable Data folder and icon beside the versions.",
        parameters: workletToolInstallInputSchema,
        returnType: Type.Object({ worklet: workletSchema }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkletToolInstallInput, call) =>
            await module.installForTool(ctx, agentId, input, call),
        toLLM: ({ worklet }) => [
            {
                type: "text",
                text: module.formatOperationForModel("Worklet installed", worklet),
            },
        ],
    });
}