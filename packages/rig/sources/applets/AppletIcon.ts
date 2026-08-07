import { rgbaToThumbHash } from "thumbhash";

import { getImageProcessor } from "../images/getImageProcessor.js";

export const APPLET_ICON_SIZE = 512;
export const APPLET_ICON_MAX_BYTES = 4 * 1024 * 1024;

const ICO_SIZES = [16, 32, 48, 64, 128, 256] as const;

export class AppletIconInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AppletIconInvalidError";
    }
}

export interface AppletIconArtifacts {
    ico: Buffer;
    png: Buffer;
    thumbhash: string;
}

/**
 * Validates the identity icon supplied for an applet and derives display artifacts from it.
 *
 * `png` deliberately remains the exact supplied bytes. The ICO contains PNG frames with a
 * transparent superellipse mask, matching the softly rounded macOS icon silhouette.
 */
export async function createAppletIconArtifacts(source: Uint8Array): Promise<AppletIconArtifacts> {
    const png = Buffer.from(source);
    if (png.byteLength > APPLET_ICON_MAX_BYTES) {
        throw new AppletIconInvalidError("The applet icon exceeds the 4 MiB limit.");
    }

    const sharp = await getImageProcessor();
    let image;
    try {
        image = sharp(png, {
            animated: false,
            failOn: "error",
            limitInputPixels: APPLET_ICON_SIZE * APPLET_ICON_SIZE,
        });
    } catch {
        throw new AppletIconInvalidError("The applet icon is not a readable PNG image.");
    }
    let metadata;
    try {
        metadata = await image.metadata();
    } catch {
        throw new AppletIconInvalidError("The applet icon is not a readable PNG image.");
    }
    if (metadata.format !== "png") {
        throw new AppletIconInvalidError("The applet icon must be a PNG image.");
    }
    if (metadata.width !== APPLET_ICON_SIZE || metadata.height !== APPLET_ICON_SIZE) {
        throw new AppletIconInvalidError("The applet icon must be exactly 512 by 512 pixels.");
    }

    let normalized;
    try {
        normalized = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch {
        throw new AppletIconInvalidError("The applet icon could not be decoded.");
    }
    if (normalized.info.width !== APPLET_ICON_SIZE || normalized.info.height !== APPLET_ICON_SIZE) {
        throw new AppletIconInvalidError("The applet icon must be exactly 512 by 512 pixels.");
    }
    const thumbnail = await sharp(normalized.data, {
        raw: {
            channels: 4,
            height: normalized.info.height,
            width: normalized.info.width,
        },
    })
        .resize(100, 100, { fit: "fill", kernel: "lanczos3" })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const thumbhash = Buffer.from(
        rgbaToThumbHash(thumbnail.info.width, thumbnail.info.height, thumbnail.data),
    ).toString("base64");

    const frames = await Promise.all(ICO_SIZES.map((size) => createRoundedPngFrame(png, size)));
    return { ico: encodeIco(frames), png, thumbhash };
}

async function createRoundedPngFrame(source: Buffer, size: number): Promise<Buffer> {
    const sharp = await getImageProcessor();
    const mask = createSquircleMask(size);
    return sharp(source, {
        animated: false,
        failOn: "error",
        limitInputPixels: APPLET_ICON_SIZE * APPLET_ICON_SIZE,
    })
        .resize(size, size, { fit: "fill", kernel: "lanczos3" })
        .ensureAlpha()
        .composite([
            {
                blend: "dest-in",
                input: mask,
                raw: { channels: 4, height: size, width: size },
            },
        ])
        .png()
        .toBuffer();
}

/**
 * A sampled superellipse (`x^4 + y^4 = 1`) gives a macOS-like squircle rather than a plain
 * rounded rectangle. Four samples per pixel preserve an antialiased transparent edge.
 */
function createSquircleMask(size: number): Buffer {
    const mask = Buffer.alloc(size * size * 4);
    const samples = [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
    ] as const;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            let covered = 0;
            for (const [sampleX, sampleY] of samples) {
                const horizontal = ((x + sampleX) / size) * 2 - 1;
                const vertical = ((y + sampleY) / size) * 2 - 1;
                if (horizontal ** 4 + vertical ** 4 <= 1) covered += 1;
            }
            const offset = (y * size + x) * 4;
            mask[offset] = 255;
            mask[offset + 1] = 255;
            mask[offset + 2] = 255;
            mask[offset + 3] = Math.round((covered / samples.length) * 255);
        }
    }
    return mask;
}

/** Encodes PNG frames as a standard ICO file without a platform-specific image utility. */
function encodeIco(frames: readonly Buffer[]): Buffer {
    const directoryLength = 6 + frames.length * 16;
    const directory = Buffer.alloc(directoryLength);
    directory.writeUInt16LE(0, 0);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(frames.length, 4);

    let offset = directoryLength;
    for (const [index, frame] of frames.entries()) {
        const size = ICO_SIZES[index]!;
        const entry = 6 + index * 16;
        directory[entry] = size === 256 ? 0 : size;
        directory[entry + 1] = size === 256 ? 0 : size;
        directory[entry + 2] = 0;
        directory[entry + 3] = 0;
        directory.writeUInt16LE(1, entry + 4);
        directory.writeUInt16LE(32, entry + 6);
        directory.writeUInt32LE(frame.byteLength, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += frame.byteLength;
    }
    return Buffer.concat([directory, ...frames]);
}
