import { rgbaToThumbHash } from "thumbhash";

import { getImageProcessor } from "../images/getImageProcessor.js";
import type { RigProfilePhoto, RigProfilePhotoInput } from "../protocol/index.js";

const MAXIMUM_INPUT_BYTES = 24 * 1024 * 1024;
const MAXIMUM_INPUT_PIXELS = 40_000_000;
export const MAXIMUM_RIG_PROFILE_PHOTO_BYTES = 96 * 1024;
const CANDIDATE_DIMENSIONS = [512, 448, 384, 320, 256, 224, 192] as const;
const THUMBHASH_DIMENSION = 100;

/** Converts a readable input image into the single Rig profile-photo format. */
export async function normalizeRigProfilePhoto(
    input: RigProfilePhotoInput,
): Promise<RigProfilePhoto> {
    const source = decodeBase64(input.data);
    try {
        const sharp = await getImageProcessor();
        const image = sharp(source, {
            animated: false,
            failOn: "error",
            limitInputPixels: MAXIMUM_INPUT_PIXELS,
        }).rotate();
        const metadata = await image.metadata();
        if (
            metadata.width === undefined ||
            metadata.height === undefined ||
            metadata.width < 1 ||
            metadata.height < 1
        ) {
            throw new Error("The Rig profile photo dimensions could not be determined.");
        }
        let webp: Buffer | undefined;
        for (const dimension of CANDIDATE_DIMENSIONS) {
            const candidate = await image
                .clone()
                .resize(dimension, dimension, { fit: "inside", withoutEnlargement: true })
                .webp({ effort: 4, quality: 82 })
                .toBuffer();
            if (candidate.byteLength <= MAXIMUM_RIG_PROFILE_PHOTO_BYTES) {
                webp = candidate;
                break;
            }
            candidate.fill(0);
        }
        if (webp === undefined) {
            throw new Error("The Rig profile photo could not fit the size limit.");
        }
        const normalized = await sharp(webp).metadata();
        if (
            normalized.width === undefined ||
            normalized.height === undefined ||
            normalized.width < 1 ||
            normalized.height < 1
        ) {
            throw new Error("The Rig profile photo could not be normalized.");
        }
        const thumbnail = await sharp(webp)
            .ensureAlpha()
            .resize(THUMBHASH_DIMENSION, THUMBHASH_DIMENSION, {
                fit: "inside",
                withoutEnlargement: false,
            })
            .raw()
            .toBuffer({ resolveWithObject: true });
        return {
            bytes: webp.byteLength,
            data: webp.toString("base64"),
            height: normalized.height,
            mediaType: "image/webp",
            thumbhash: Buffer.from(
                rgbaToThumbHash(thumbnail.info.width, thumbnail.info.height, thumbnail.data),
            ).toString("base64"),
            width: normalized.width,
        };
    } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("The Rig profile photo")) {
            throw error;
        }
        throw new Error("The Rig profile photo is not a readable image.", { cause: error });
    } finally {
        source.fill(0);
    }
}

function decodeBase64(value: string): Buffer {
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength === 0 || decoded.byteLength > MAXIMUM_INPUT_BYTES) {
        throw new Error("The Rig profile photo must be between 1 byte and 24 MiB.");
    }
    const canonical = decoded.toString("base64");
    if (canonical !== value && canonical.replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
        decoded.fill(0);
        throw new Error("The Rig profile photo data is not valid base64.");
    }
    return decoded;
}
