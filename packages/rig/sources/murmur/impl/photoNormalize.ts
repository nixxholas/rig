import { rgbaToThumbHash } from "thumbhash";

import type { MurmurPhoto, MurmurPhotoInput } from "../../protocol/MurmurProtocol.js";
import { getImageProcessor } from "../../images/getImageProcessor.js";

const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_PROFILE_PHOTO_BYTES = 96 * 1024;
const PROFILE_DIMENSIONS = [512, 448, 384, 320, 256, 224, 192] as const;
const THUMBHASH_DIMENSION = 100;

function decodeBase64(value: string): Buffer {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0 || decoded.length > MAX_INPUT_BYTES) {
        throw new Error("Murmur profile photos must be between 1 byte and 24 MiB");
    }
    const canonical = decoded.toString("base64");
    if (canonical !== value && canonical.replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
        decoded.fill(0);
        throw new Error("Murmur profile photo data is not valid base64");
    }
    return decoded;
}

/** Normalize a readable input image to the single Murmur profile-photo format. */
export async function normalizeMurmurPhoto(input: MurmurPhotoInput): Promise<MurmurPhoto> {
    const source = decodeBase64(input.data);
    try {
        const sharp = await getImageProcessor();
        const image = sharp(source, {
            animated: false,
            failOn: "error",
            limitInputPixels: MAX_INPUT_PIXELS,
        }).rotate();
        const metadata = await image.metadata();
        if (
            metadata.width === undefined ||
            metadata.height === undefined ||
            metadata.width < 1 ||
            metadata.height < 1
        ) {
            throw new Error("Murmur profile photo dimensions could not be determined");
        }
        let webp: Buffer | undefined;
        for (const dimension of PROFILE_DIMENSIONS) {
            const candidate = await image
                .clone()
                .resize(dimension, dimension, {
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ effort: 4, quality: 82 })
                .toBuffer();
            if (candidate.byteLength <= MAX_PROFILE_PHOTO_BYTES) {
                webp = candidate;
                break;
            }
            candidate.fill(0);
        }
        if (webp === undefined) {
            throw new Error("Murmur profile photo could not fit the relay-safe size limit");
        }
        const normalizedMetadata = await sharp(webp).metadata();
        if (
            normalizedMetadata.width === undefined ||
            normalizedMetadata.height === undefined ||
            normalizedMetadata.width < 1 ||
            normalizedMetadata.height < 1
        ) {
            throw new Error("Murmur profile photo normalization failed");
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
            height: normalizedMetadata.height,
            mediaType: "image/webp",
            thumbhash: Buffer.from(
                rgbaToThumbHash(thumbnail.info.width, thumbnail.info.height, thumbnail.data),
            ).toString("base64"),
            width: normalizedMetadata.width,
        };
    } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("Murmur profile photo")) {
            throw error;
        }
        throw new Error("Murmur profile photo is not a readable image", { cause: error });
    } finally {
        source.fill(0);
    }
}
