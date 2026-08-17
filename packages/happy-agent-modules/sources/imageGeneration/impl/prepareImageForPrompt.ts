import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../ImageGeneration.js";
import { getImageProcessor } from "./getImageProcessor.js";
import { ImageProcessingError } from "./ImageProcessingError.js";
import {
    promptImageOutputDimensions,
    type PromptImageResizeLimits,
} from "./promptImageOutputDimensions.js";

const ORIGINAL_DETAIL_LIMITS: PromptImageResizeLimits = {
    maxDimension: 6000,
    maxPatches: 10_000,
};

export type PromptImageMediaType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

export interface PreparedPromptImage {
    bytes: Buffer;
    height: number;
    mediaType: PromptImageMediaType;
    width: number;
}

/**
 * One source image, decoded and made safe to send.
 *
 * An image an edit is built from is sent at its own resolution wherever that already fits, so the
 * picture the person meant is the picture the provider sees. Only an image too large to send at
 * all is rescaled, and its bytes are re-encoded rather than passed through, so a file that merely
 * claims to be an image cannot reach the provider unexamined.
 */
export async function prepareImageForPrompt(bytes: Uint8Array): Promise<PreparedPromptImage> {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (input.length === 0) {
        throw new ImageProcessingError("Image file is empty.");
    }
    if (input.length > MAX_PROMPT_IMAGE_INPUT_BYTES) {
        throw new ImageProcessingError("Image exceeds the supported size limit.");
    }

    try {
        const sharp = await getImageProcessor();
        const metadata = await sharp(input, { failOn: "error" }).metadata();
        const width = metadata.width;
        const height = metadata.height;
        if (width === undefined || height === undefined || width < 1 || height < 1) {
            throw new ImageProcessingError("Image dimensions could not be determined.");
        }

        const sourceFormat = metadata.format;
        const preservableMediaType =
            sourceFormat === "jpeg"
                ? "image/jpeg"
                : sourceFormat === "png"
                  ? "image/png"
                  : sourceFormat === "webp"
                    ? "image/webp"
                    : undefined;

        const target = promptImageOutputDimensions(width, height, ORIGINAL_DETAIL_LIMITS);
        const shouldResize = target.width !== width || target.height !== height;

        if (!shouldResize && preservableMediaType !== undefined) {
            await sharp(input, { failOn: "error" }).stats();
            return { bytes: input, height, mediaType: preservableMediaType, width };
        }

        let pipeline = sharp(input, { failOn: "error" });
        if (shouldResize) {
            pipeline = pipeline.resize(target.width, target.height, {
                fit: "fill",
                kernel: sharp.kernel.linear,
            });
        }
        // Match Codex: keep EXIF orientation paired with unrotated pixels instead of baking it in.
        pipeline = pipeline.keepMetadata();

        const outputMediaType = preservableMediaType ?? "image/png";
        if (outputMediaType === "image/jpeg") {
            pipeline = pipeline.jpeg({ quality: 85 });
        } else if (outputMediaType === "image/webp") {
            pipeline = pipeline.webp({ lossless: true });
        } else {
            pipeline = pipeline.png();
        }

        return {
            bytes: await pipeline.toBuffer(),
            height: target.height,
            mediaType: outputMediaType,
            width: target.width,
        };
    } catch (error) {
        if (error instanceof ImageProcessingError) {
            throw error;
        }
        throw new ImageProcessingError("Image could not be decoded or normalized.", {
            cause: error,
        });
    }
}
