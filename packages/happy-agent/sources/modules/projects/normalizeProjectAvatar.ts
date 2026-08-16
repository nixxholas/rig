import { createHash } from "node:crypto";

import sharp from "sharp";

export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

export interface NormalizedProjectAvatar {
    readonly bytes: Buffer;
    readonly hash: string;
    readonly height: number;
    readonly width: number;
}

/**
 * Turns whatever image was offered into the one shape the catalog stores: a bounded, oriented,
 * square-fitting WebP addressed by the hash of its own bytes. Two projects that arrive at the
 * same picture therefore share one stored asset.
 */
export async function normalizeProjectAvatar(bytes: Buffer): Promise<NormalizedProjectAvatar> {
    const image = sharp(bytes, {
        animated: false,
        failOn: "error",
        limitInputPixels: 25_000_000,
    }).rotate();
    const metadata = await image.metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error("The project image does not contain a readable picture.");
    }
    const result = await image
        .resize({
            fit: "inside",
            height: 256,
            kernel: "lanczos3",
            width: 256,
            withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
    return {
        bytes: result.data,
        hash: createHash("sha256").update(result.data).digest("hex"),
        height: result.info.height,
        width: result.info.width,
    };
}

/**
 * Reads a response body without letting the far end decide how much memory Rig spends. The
 * declared length is checked first, and the stream is cut off the moment it exceeds the bound.
 */
export async function readBoundedResponseBytes(
    response: Response,
    maximumBytes: number,
    controller: AbortController,
): Promise<Buffer> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        controller.abort();
        throw new Error("The remote project image is too large.");
    }
    if (response.body === null) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maximumBytes) {
                controller.abort();
                await reader.cancel();
                throw new Error("The remote project image is too large.");
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        byteLength,
    );
}
