import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** The largest identity icon this module will read from a source path. */
export const MAX_APPLET_ICON_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A validated applet identity icon, ready to write beside the version folders.
 *
 * `png` is the exact supplied bytes. `ico` wraps the same PNG as a single ICO
 * frame so a host can serve `favicon.ico` without a separate transcode. This
 * package has no image-decoding dependency, so it does not resize the icon,
 * apply a rounded mask, or derive a perceptual thumbhash the way the daemon's
 * richer importer does; it validates the PNG and packages it faithfully.
 */
export interface StagedAppletIcon {
    readonly png: Buffer;
    readonly ico: Buffer;
    readonly width: number;
    readonly height: number;
}

/**
 * Reads and validates the icon at an absolute source path. The path must be a
 * regular, non-symlink PNG file within the byte cap.
 */
export async function stageAppletIcon(iconPath: string): Promise<StagedAppletIcon> {
    if (!isAbsolute(iconPath)) {
        throw new Error("The applet icon path must be an absolute path on this machine.");
    }
    let facts;
    try {
        facts = await lstat(iconPath);
    } catch {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} does not exist.`);
    }
    if (facts.isSymbolicLink() || !facts.isFile()) {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} is not a regular file.`);
    }
    if (facts.size > MAX_APPLET_ICON_BYTES) {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`);
    }
    const png = await readIconBytes(iconPath);
    const dimensions = readPngDimensions(png);
    if (dimensions === undefined) {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} is not a readable PNG image.`);
    }
    return {
        png,
        ico: encodePngIco(png, dimensions.width, dimensions.height),
        width: dimensions.width,
        height: dimensions.height,
    };
}

async function readIconBytes(path: string): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        while (length <= MAX_APPLET_ICON_BYTES) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_APPLET_ICON_BYTES + 1 - length));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) return Buffer.concat(chunks, length);
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
        }
        throw new Error("The applet icon exceeds the 4 MiB limit.");
    } finally {
        await file.close();
    }
}

/** Reads a PNG's pixel dimensions from its IHDR chunk without decoding pixels. */
function readPngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
    if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
    if (bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1) return undefined;
    return { width, height };
}

/** Wraps a PNG as a one-frame ICO file. Modern ICO supports PNG-compressed frames. */
function encodePngIco(png: Buffer, width: number, height: number): Buffer {
    const directory = Buffer.alloc(22);
    directory.writeUInt16LE(0, 0); // reserved
    directory.writeUInt16LE(1, 2); // type: icon
    directory.writeUInt16LE(1, 4); // one frame
    directory[6] = width >= 256 ? 0 : width;
    directory[7] = height >= 256 ? 0 : height;
    directory[8] = 0; // palette color count
    directory[9] = 0; // reserved
    directory.writeUInt16LE(1, 10); // color planes
    directory.writeUInt16LE(32, 12); // bits per pixel
    directory.writeUInt32LE(png.byteLength, 14); // bytes in the frame
    directory.writeUInt32LE(22, 18); // frame offset
    return Buffer.concat([directory, png]);
}
