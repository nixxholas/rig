import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import {
    ExecutorImageGenerationUnavailableError,
    type ExecutorImageGeneration,
} from "@slopus/rig-execution";

import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";
import { defineTool, type Message } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { shouldReviewPathInAutoMode } from "../../permissions/shouldReviewPathInAutoMode.js";
import {
    getImageProcessor,
    MAX_PROMPT_IMAGE_INPUT_BYTES,
    prepareImageForPrompt,
} from "../utils/index.js";
import { writeGeneratedMediaFile } from "../gemini/writeGeneratedMediaFile.js";

const MAX_EDIT_IMAGES = 5;
const MAX_EDIT_IMAGES_ENCODED_BYTES = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageGenerationProvider {
    id: string;
    imageGeneration: ExecutorImageGeneration;
}

export function createImageGenerationTool(providers: readonly ImageGenerationProvider[]) {
    if (providers.length === 0) {
        throw new Error("Image generation requires at least one provider.");
    }
    let roundRobinOffset = 0;

    return defineTool({
        name: "imagegen",
        namespace: {
            name: "image_gen",
            description: "Tools for generating and editing images.",
        },
        label: "Image generation",
        description:
            "Generate a new image or edit up to five referenced images. Omit both image reference fields for a new image. For edits, provide local image paths or request the smallest sufficient number of recent conversation images, but never both.",
        arguments: Type.Object(
            {
                prompt: Type.String({ minLength: 2 }),
                num_last_images_to_include: Type.Optional(
                    Type.Integer({ minimum: 1, maximum: MAX_EDIT_IMAGES }),
                ),
                referenced_image_paths: Type.Optional(
                    Type.Array(Type.String(), { maxItems: MAX_EDIT_IMAGES }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            bytes: Type.Number(),
            media_type: Type.Literal("image/png"),
            path: Type.String(),
            image_base64: Type.String(),
        }),
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: ({
            prompt,
            num_last_images_to_include,
            referenced_image_paths,
        }) =>
            `sending ${quoteVisibleExact(prompt)}${
                referenced_image_paths === undefined
                    ? ""
                    : ` and ${String(referenced_image_paths.length)} local image reference(s)`
            }${
                num_last_images_to_include === undefined
                    ? ""
                    : ` and ${String(num_last_images_to_include)} recent conversation image(s)`
            } to Codex image generation. If an account definitively refuses the request, Rig may send the same data to another of ${String(providers.length)} configured Codex cloud provider(s), including providers with custom endpoints. Access: conversation data, local filesystem read/write, and external Codex APIs`,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: async ({ referenced_image_paths }, context) => {
            for (const path of referenced_image_paths ?? []) {
                if (await shouldReviewPathInAutoMode(path, context, { write: false })) return true;
            }
            return false;
        },
        execute: async (args, context, execution) => {
            if (
                args.referenced_image_paths !== undefined &&
                args.num_last_images_to_include !== undefined
            ) {
                throw new Error(
                    "Provide only one of referenced_image_paths or num_last_images_to_include.",
                );
            }
            const images =
                args.referenced_image_paths === undefined
                    ? recentConversationImages(
                          execution.messages ?? [],
                          args.num_last_images_to_include,
                      )
                    : await prepareReferencedImages(
                          args.referenced_image_paths,
                          context.fs,
                          context.fs.cwd,
                          context.fs.home,
                      );
            assertAggregateImageSize(images);
            const offset = roundRobinOffset++ % providers.length;
            const rotated = [...providers.slice(offset), ...providers.slice(0, offset)];
            const preferredId = execution.provider?.id;
            const preferred = rotated.find((candidate) => candidate.id === preferredId);
            const ordered =
                preferred === undefined
                    ? rotated
                    : [preferred, ...rotated.filter((candidate) => candidate !== preferred)];
            const failures: string[] = [];
            const turnId =
                execution.toolCallId ?? `image-${Date.now()}-${String(roundRobinOffset)}`;
            let successful:
                | {
                      generated: Awaited<ReturnType<ExecutorImageGeneration["generate"]>>;
                  }
                | undefined;
            for (const provider of ordered) {
                try {
                    execution.onStatus?.(`Generating image with ${provider.id}`);
                    const generated = await provider.imageGeneration.generate({
                        ...(images.length === 0 ? {} : { images }),
                        prompt: args.prompt,
                        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                        turnId,
                    });
                    successful = { generated };
                    break;
                } catch (error) {
                    execution.signal?.throwIfAborted();
                    if (!(error instanceof ExecutorImageGenerationUnavailableError)) {
                        throw error;
                    }
                    failures.push(error instanceof Error ? error.message : String(error));
                }
            }
            if (successful === undefined) {
                throw new Error(
                    `No configured Codex image provider succeeded. ${failures.join(" ")}`,
                );
            }
            const bytes = await decodeAndValidatePng(successful.generated.base64);
            const callId = turnId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
            const path = await writeGeneratedMediaFile(
                join(context.fs.cwd, "generated_images", `${callId}.png`),
                bytes,
                context,
            );
            return {
                bytes: bytes.byteLength,
                image_base64: successful.generated.base64,
                media_type: successful.generated.mediaType,
                path,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Generated image at ${result.path} (${String(result.bytes)} bytes).`,
            },
            {
                type: "image",
                mediaType: result.media_type,
                data: result.image_base64,
                detail: "original",
            },
        ],
        toUI: (result) => `Generated image at ${result.path}`,
        locks: ["image_generation"],
    });
}

async function prepareReferencedImages(
    paths: readonly string[],
    fs: import("../../agent/context/FileSystemContext.js").FileSystemContext,
    cwd: string,
    home: string | undefined,
): Promise<string[]> {
    const references: string[] = [];
    let sourceBytes = 0;
    for (const path of paths) {
        const resolved = resolveFileSystemPath(path, cwd, home);
        const stat = await fs.stat(resolved);
        if (!stat.isFile) throw new Error(`Referenced image '${path}' is not a file.`);
        if (stat.size > MAX_PROMPT_IMAGE_INPUT_BYTES) {
            throw new Error(`Referenced image '${path}' exceeds the supported image size.`);
        }
        sourceBytes += stat.size;
        if (sourceBytes > MAX_PROMPT_IMAGE_INPUT_BYTES) {
            throw new Error("Referenced images exceed the 32 MiB aggregate input limit.");
        }
        references.push(resolved);
    }

    const images: string[] = [];
    for (const reference of references) {
        const image = await prepareImageForPrompt(await fs.readFileBuffer(reference), "original");
        images.push(`data:${image.mediaType};base64,${image.bytes.toString("base64")}`);
    }
    return images;
}

function assertAggregateImageSize(images: readonly string[]): void {
    const bytes = images.reduce((total, image) => total + Buffer.byteLength(image), 0);
    if (bytes > MAX_EDIT_IMAGES_ENCODED_BYTES) {
        throw new Error("Referenced images exceed the 48 MiB encoded request limit.");
    }
}

async function decodeAndValidatePng(base64: string): Promise<Buffer> {
    const normalized = base64.trim();
    if (
        normalized.length === 0 ||
        normalized.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
    ) {
        throw new Error("The image provider returned invalid base64 image data.");
    }
    const bytes = Buffer.from(normalized, "base64");
    if (
        bytes.toString("base64") !== normalized ||
        bytes.length < PNG_SIGNATURE.length ||
        !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
        throw new Error("The image provider returned data that is not a PNG image.");
    }
    try {
        const sharp = await getImageProcessor();
        const metadata = await sharp(bytes, {
            failOn: "error",
            limitInputPixels: 40_000_000,
        }).metadata();
        if (metadata.format !== "png") {
            throw new Error("The decoded image format is not PNG.");
        }
        await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).stats();
    } catch (error) {
        throw new Error("The image provider returned a malformed PNG image.", { cause: error });
    }
    return bytes;
}

function recentConversationImages(messages: readonly Message[], requested: number | undefined) {
    if (requested === undefined) return [];
    const images: string[] = [];
    let complete = false;
    const addImage = (mediaType: string, data: string) => {
        images.push(`data:${mediaType};base64,${data}`);
        complete = images.length === requested;
    };
    messageLoop: for (const message of [...messages].reverse()) {
        for (const block of [...message.blocks].reverse()) {
            if (block.type === "image") {
                addImage(block.mediaType, block.data);
            } else if (block.type === "tool_result") {
                for (const content of [...block.rendered].reverse()) {
                    if (content.type === "image") {
                        addImage(content.mediaType, content.data);
                        if (complete) break;
                    }
                }
            }
            if (complete) break messageLoop;
        }
    }
    if (complete) return images.reverse();
    throw new Error(
        `Requested the last ${String(requested)} conversation images, but only ${String(images.length)} were available.`,
    );
}
