import { getImageProcessor } from "../images/getImageProcessor.js";
import type { RigProfilePhoto } from "../protocol/index.js";

const MAXIMUM_PROFILE_PHOTO_PIXELS = 40_000_000;

/** Verifies that a replicated photo's declared metadata describes its WebP bytes. */
export async function validateRigProfilePhoto(photo: RigProfilePhoto): Promise<void> {
    const data = decodeCanonicalBase64(photo.data, "photo");
    try {
        if (data.byteLength !== photo.bytes) {
            throw new Error("The Rig profile photo byte count is invalid.");
        }
        const thumbhash = decodeCanonicalBase64(photo.thumbhash, "thumbhash");
        thumbhash.fill(0);
        const sharp = await getImageProcessor();
        const metadata = await sharp(data, {
            animated: false,
            failOn: "error",
            limitInputPixels: MAXIMUM_PROFILE_PHOTO_PIXELS,
        }).metadata();
        if (
            metadata.format !== "webp" ||
            metadata.width !== photo.width ||
            metadata.height !== photo.height
        ) {
            throw new Error("The Rig profile photo metadata is invalid.");
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("The Rig profile photo")) {
            throw error;
        }
        throw new Error("The Rig profile photo is not a readable WebP image.", { cause: error });
    } finally {
        data.fill(0);
    }
}

function decodeCanonicalBase64(value: string, field: string): Buffer {
    const decoded = Buffer.from(value, "base64");
    const canonical = decoded.toString("base64");
    if (
        decoded.byteLength === 0 ||
        (canonical !== value && canonical.replace(/=+$/u, "") !== value.replace(/=+$/u, ""))
    ) {
        decoded.fill(0);
        throw new Error(`The Rig profile ${field} is not valid base64.`);
    }
    return decoded;
}
