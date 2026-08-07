import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeRigProfilePhoto } from "./normalizeRigProfilePhoto.js";
import { validateRigProfilePhoto } from "./validateRigProfilePhoto.js";

describe("validateRigProfilePhoto", () => {
    it("accepts normalized WebP bytes and rejects forged metadata", async () => {
        const png = await sharp({
            create: {
                background: { alpha: 1, b: 80, g: 40, r: 220 },
                channels: 4,
                height: 90,
                width: 180,
            },
        })
            .png()
            .toBuffer();
        const photo = await normalizeRigProfilePhoto({
            data: png.toString("base64"),
            mediaType: "image/png",
        });

        await expect(validateRigProfilePhoto(photo)).resolves.toBeUndefined();
        await expect(validateRigProfilePhoto({ ...photo, width: photo.width + 1 })).rejects.toThrow(
            "metadata is invalid",
        );
        await expect(
            validateRigProfilePhoto({ ...photo, data: Buffer.from("not-webp").toString("base64") }),
        ).rejects.toThrow();
    });
});
