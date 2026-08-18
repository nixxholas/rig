import { createHash } from "node:crypto";

import sharp from "sharp";

import { rgbaToThumbHash } from "./rgbaToThumbHash.js";

export const MAX_PROFILE_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_PIXELS = 25_000_000;
const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface NormalizedProfilePhoto {
    readonly bytes: Buffer;
    readonly contentHash: string;
    readonly contentType: "image/webp";
    readonly height: number;
    readonly thumbhash: string;
    readonly width: number;
}

/** Decode, orient, bound, and strip metadata from an uploaded profile photo. */
export async function normalizeProfilePhoto(
    bytes: Uint8Array,
    declaredContentType: string,
): Promise<NormalizedProfilePhoto> {
    if (!ACCEPTED_MEDIA_TYPES.has(declaredContentType)) {
        throw new Error("The profile photo must be a PNG, JPEG, or WebP image.");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROFILE_PHOTO_BYTES) {
        throw new Error("The profile photo must be no larger than 8 MiB.");
    }

    const input = Buffer.from(bytes);
    const image = sharp(input, {
        animated: false,
        failOn: "error",
        limitInputPixels: MAX_DECODED_PIXELS,
    }).rotate();
    const metadata = await image.metadata();
    const actualContentType =
        metadata.format === "png"
            ? "image/png"
            : metadata.format === "jpeg"
              ? "image/jpeg"
              : metadata.format === "webp"
                ? "image/webp"
                : undefined;
    if (actualContentType === undefined || actualContentType !== declaredContentType) {
        throw new Error("The profile photo does not match its content type.");
    }

    const normalized = await image
        .resize({
            fit: "inside",
            height: 512,
            kernel: "lanczos3",
            width: 512,
            withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
    if (
        normalized.info.width < 1 ||
        normalized.info.height < 1 ||
        normalized.data.byteLength > MAX_PROFILE_PHOTO_BYTES
    ) {
        throw new Error("The normalized profile photo is invalid.");
    }

    const placeholder = await sharp(normalized.data, {
        animated: false,
        failOn: "error",
        limitInputPixels: MAX_DECODED_PIXELS,
    })
        .resize({
            fit: "inside",
            height: 100,
            kernel: "lanczos3",
            width: 100,
            withoutEnlargement: true,
        })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const thumbhash = Buffer.from(
        rgbaToThumbHash(placeholder.info.width, placeholder.info.height, placeholder.data),
    ).toString("base64");

    return {
        bytes: normalized.data,
        contentHash: createHash("sha256").update(normalized.data).digest("hex"),
        contentType: "image/webp",
        height: normalized.info.height,
        thumbhash,
        width: normalized.info.width,
    };
}
