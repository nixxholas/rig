import { isAbsolute } from "node:path";

import { assertAppletSourceReader, type AppletSourceReader } from "./copyAppletTree.js";
import {
    APPLET_ICON_SIZE,
    APPLET_THUMBNAIL_SIZE,
    decodePngToRgba,
    resizeRgbaLanczos,
} from "./pngImage.js";
import { rgbaToThumbHash } from "./thumbhash.js";

/** The largest identity icon this module will read from a source path. */
export const MAX_APPLET_ICON_BYTES = 4 * 1024 * 1024;

/**
 * A validated applet identity icon, ready to write beside the version folders.
 *
 * `png` is the exact supplied bytes. `ico` wraps the same PNG as a single ICO
 * frame so a host can serve `favicon.ico` without a separate transcode.
 */
export interface StagedAppletIcon {
    readonly png: Buffer;
    readonly ico: Buffer;
    readonly thumbhash: string;
    readonly width: number;
    readonly height: number;
}
/**
 * Reads and validates a 512×512 icon at an absolute source path. The path must
 * be a regular, non-symlink PNG file within the byte cap.
 */
export async function stageAppletIcon(
    iconPath: string,
    sourceReader: AppletSourceReader,
): Promise<StagedAppletIcon> {
    if (!isAbsolute(iconPath)) {
        throw new Error("The applet icon path must be an absolute path on this machine.");
    }
    assertAppletSourceReader(sourceReader);
    let facts;
    try {
        facts = await sourceReader.lstat(iconPath);
    } catch {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} does not exist.`);
    }
    if (facts.isSymbolicLink || !facts.isFile) {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} is not a regular file.`);
    }
    if (facts.size > MAX_APPLET_ICON_BYTES) {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`);
    }
    const bytes = await sourceReader.readFileBuffer(iconPath, {
        maxBytes: MAX_APPLET_ICON_BYTES,
        noFollow: true,
    });
    if (bytes.byteLength > MAX_APPLET_ICON_BYTES) {
        throw new Error(`The applet icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`);
    }
    const png = Buffer.from(bytes);
    let rgba: Buffer;
    try {
        rgba = decodePngToRgba(png);
    } catch (error: unknown) {
        const reason = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(
            `The applet icon ${JSON.stringify(iconPath)} is not a readable PNG image${reason}`,
        );
    }
    const thumbnail = resizeRgbaLanczos(
        rgba,
        APPLET_ICON_SIZE,
        APPLET_ICON_SIZE,
        APPLET_THUMBNAIL_SIZE,
        APPLET_THUMBNAIL_SIZE,
    );
    return {
        png,
        ico: encodePngIco(png, APPLET_ICON_SIZE, APPLET_ICON_SIZE),
        thumbhash: Buffer.from(
            rgbaToThumbHash(APPLET_THUMBNAIL_SIZE, APPLET_THUMBNAIL_SIZE, thumbnail),
        ).toString("base64"),
        width: APPLET_ICON_SIZE,
        height: APPLET_ICON_SIZE,
    };
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
