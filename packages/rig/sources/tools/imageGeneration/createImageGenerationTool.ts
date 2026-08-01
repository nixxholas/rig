import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
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

const imageGenerationArguments = Type.Object(
    {
        prompt: Type.String({ minLength: 2 }),
        // Codex models trained against the built-in image tool send an explicit `null` instead of
        // omitting an unused selector, so both selectors accept it.
        num_last_images_to_include: Type.Optional(
            Type.Union([Type.Integer({ minimum: 1, maximum: MAX_EDIT_IMAGES }), Type.Null()]),
        ),
        referenced_image_paths: Type.Optional(
            Type.Union([Type.Array(Type.String(), { maxItems: MAX_EDIT_IMAGES }), Type.Null()]),
        ),
    },
    { additionalProperties: false },
);

type ImageGenerationArguments = Static<typeof imageGenerationArguments>;

export interface ImageGenerationProvider {
    id: string;
    imageGeneration: ExecutorImageGeneration;
}

/** The vendor-facing name and guidance for one model family's image tool. */
export interface ImageGenerationSurface {
    name: string;
    description: string;
}

export function createImageGenerationTool(
    providers: readonly ImageGenerationProvider[],
    surface: ImageGenerationSurface,
) {
    if (providers.length === 0) {
        throw new Error("Image generation requires at least one provider.");
    }
    let roundRobinOffset = 0;

    return defineTool({
        // The Responses API reserves the `image_gen` namespace for its own image tool and rejects
        // every request whose `image_gen.imagegen` definition differs from that built-in one, so
        // every vendor surface stays a plain top-level function.
        name: surface.name,
        label: "Image generation",
        description: surface.description,
        arguments: imageGenerationArguments,
        returnType: Type.Object({
            bytes: Type.Number(),
            media_type: Type.Literal("image/png"),
            path: Type.String(),
            image_base64: Type.String(),
        }),
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: (args) => {
            const paths = selectedPaths(args);
            const recent = selectedRecentCount(args);
            return `sending ${quoteVisibleExact(args.prompt)}${
                paths === undefined ? "" : ` and ${String(paths.length)} local image reference(s)`
            }${
                recent === undefined ? "" : ` and ${String(recent)} recent conversation image(s)`
            } to Codex image generation. If an account definitively refuses the request, Rig may send the same data to another of ${String(providers.length)} configured Codex cloud provider(s), including providers with custom endpoints. Access: conversation data, local filesystem read/write, and external Codex APIs`;
        },
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: async (args, context) => {
            for (const path of selectedPaths(args) ?? []) {
                if (await shouldReviewPathInAutoMode(path, context, { write: false })) return true;
            }
            return false;
        },
        execute: async (args, context, execution) => {
            const paths = selectedPaths(args);
            const recent = selectedRecentCount(args);
            if (paths !== undefined && recent !== undefined) {
                throw new Error(
                    "Provide only one of referenced_image_paths or num_last_images_to_include.",
                );
            }
            const images =
                paths === undefined
                    ? recentConversationImages(execution.messages ?? [], recent)
                    : await prepareReferencedImages(
                          paths,
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

/** Reads the local-path selector, treating an explicit `null` as an unused selector. */
function selectedPaths(args: ImageGenerationArguments): readonly string[] | undefined {
    return args.referenced_image_paths ?? undefined;
}

/** Reads the recent-conversation selector, treating an explicit `null` as an unused selector. */
function selectedRecentCount(args: ImageGenerationArguments): number | undefined {
    return args.num_last_images_to_include ?? undefined;
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
    let remainingBytes = MAX_PROMPT_IMAGE_INPUT_BYTES;
    for (const reference of references) {
        const bytes = await fs.readFileBuffer(reference, { maxBytes: remainingBytes });
        remainingBytes -= bytes.byteLength;
        const image = await prepareImageForPrompt(bytes, "original");
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
