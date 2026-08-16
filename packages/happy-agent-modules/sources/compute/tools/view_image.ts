import { Type, type Static } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { computeImageSchema, readImageForModel } from "../impl/readImage.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import type { FileReadLog } from "../impl/FileReadLog.js";
import { resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

const viewImageParametersSchema = Type.Object(
    {
        path: Type.String({ description: "The local image file to view." }),
    },
    { additionalProperties: false },
);

const viewImageResultSchema = Type.Object(
    {
        path: Type.String(),
        image: computeImageSchema,
    },
    { additionalProperties: false },
);

type ViewImageParameters = Static<typeof viewImageParametersSchema>;

/** The common tool for showing a local image to any provider. */
export function viewImageTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "view_image",
        description:
            "View a local PNG, JPEG, GIF, WebP, or BMP image when visual inspection is needed.",
        parameters: viewImageParametersSchema,
        returnType: viewImageResultSchema,
        durable: true,
        transactional: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "viewing"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        execute: async (ctx, { path }: ViewImageParameters) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            const image = await readImageForModel(compute, reads, ctx, permissions, filePath);
            return { path: filePath, image };
        },
        toLLM: ({ path, image }) => [
            { type: "text", text: `Image: ${path}` },
            {
                type: "image",
                data: image.data,
                mimeType: image.mime_type,
            },
        ],
    });
}
