import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
    createWebappIconArtifacts,
    WEBAPP_ICON_SIZE,
    WebappIconInvalidError,
} from "../WebappIcon.js";

describe("createWebappIconArtifacts", () => {
    it("preserves an exact 512px PNG, derives a stable ThumbHash, and creates a multi-size rounded ICO", async () => {
        const original = await sharp({
            create: {
                background: { alpha: 1, b: 30, g: 120, r: 240 },
                channels: 4,
                height: WEBAPP_ICON_SIZE,
                width: WEBAPP_ICON_SIZE,
            },
        })
            .png()
            .toBuffer();

        const first = await createWebappIconArtifacts(original);
        const second = await createWebappIconArtifacts(original);

        expect(first.png).toEqual(original);
        expect(first.thumbhash).toBe(second.thumbhash);
        expect(Buffer.from(first.thumbhash, "base64").byteLength).toBeGreaterThan(0);

        expect(first.ico.readUInt16LE(0)).toBe(0);
        expect(first.ico.readUInt16LE(2)).toBe(1);
        expect(first.ico.readUInt16LE(4)).toBe(6);

        const largestOffset = first.ico.readUInt32LE(6 + 5 * 16 + 12);
        const largestLength = first.ico.readUInt32LE(6 + 5 * 16 + 8);
        const rounded = await sharp(
            first.ico.subarray(largestOffset, largestOffset + largestLength),
        )
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        expect(rounded.info).toMatchObject({ height: 256, width: 256 });
        expect(rounded.data[3]).toBe(0);
        expect(rounded.data[(128 * 256 + 128) * 4 + 3]).toBe(255);
    });

    it.each([
        ["a non-PNG image", 512, 512, "jpeg"],
        ["a non-square PNG", 512, 256, "png"],
    ] as const)("rejects %s", async (_description, width, height, format) => {
        const image = await sharp({
            create: {
                background: { alpha: 1, b: 0, g: 0, r: 0 },
                channels: 4,
                height,
                width,
            },
        })
            [format]()
            .toBuffer();

        await expect(createWebappIconArtifacts(image)).rejects.toBeInstanceOf(
            WebappIconInvalidError,
        );
    });
});
