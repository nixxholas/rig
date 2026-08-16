import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    imageGenerationStatusSchema,
    imageGenerationToolInputSchema,
    type ImageGenerationToolInput,
} from "../ImageGeneration.js";
import type { ImageGenerationModule } from "../ImageGenerationModule.js";

export type ImageGenerationToolName = "imagegen" | "codex_imagegen";

/** Rig-compatible provider-facing surface over the provider-neutral image host boundary. */
export function generateImageTool(
    module: ImageGenerationModule,
    agentId: string,
    name: ImageGenerationToolName,
    preferredProviderId: string,
) {
    return defineAgentTool({
        name,
        description:
            name === "codex_imagegen"
                ? "Generate a new image or edit up to five referenced images. For edits, provide local paths or the smallest sufficient number of recent conversation images, never both. The finished image is saved to the shared generated-files folder."
                : "Generate a new image or edit up to five referenced images. Omit both image selectors for a new image; for an edit provide local image paths or the smallest sufficient number of recent conversation images, never both.",
        parameters: imageGenerationToolInputSchema,
        returnType: imageGenerationStatusSchema,
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({
            prompt,
            referenced_image_paths,
            num_last_images_to_include,
        }) =>
            `sending "${prompt}"${
                referenced_image_paths == null
                    ? ""
                    : ` and ${String(referenced_image_paths.length)} local image reference(s)`
            }${
                num_last_images_to_include == null
                    ? ""
                    : ` and ${String(num_last_images_to_include)} recent conversation image(s)`
            } to image generation. Access: conversation data, local filesystem read/write, and external image provider APIs`,
        execute: async (ctx, input: ImageGenerationToolInput, call) =>
            await module.generate(ctx, agentId, {
                prompt: input.prompt,
                operationId: call.id,
                preferredProviderId,
                ...(input.referenced_image_paths == null
                    ? {}
                    : { referencedImagePaths: input.referenced_image_paths }),
                ...(input.num_last_images_to_include == null
                    ? {}
                    : { recentImageCount: input.num_last_images_to_include }),
            }),
        toLLM: (status) => [
            {
                type: "text",
                text: module.formatForModel(status),
            },
        ],
    });
}
