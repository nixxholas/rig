import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    imageGenerationStatusSchema,
    imageGenerationToolInputSchema,
    type ImageGenerationToolInput,
} from "../ImageGeneration.js";
import type { ImageGenerationModule } from "../ImageGenerationModule.js";

/** The common provider-neutral image generation tool. */
export function generateImageTool(module: ImageGenerationModule, agentId: string) {
    return defineAgentTool({
        name: "generate_image",
        description:
            "Generate an image from a prompt and write it to a real file on disk. The result includes an opaque operation ID, an asset ID, and the absolute path of the file that was written.",
        parameters: imageGenerationToolInputSchema,
        returnType: imageGenerationStatusSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ImageGenerationToolInput, call) =>
            await module.generate(ctx, agentId, { ...input, operationId: call.id }),
        toLLM: (status) => [
            {
                type: "text",
                text: module.formatForModel(status),
            },
        ],
    });
}
