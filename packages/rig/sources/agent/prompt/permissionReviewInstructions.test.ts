import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PERMISSION_REVIEW_INSTRUCTIONS } from "./permissionReviewInstructions.js";

describe("permission review instructions", () => {
    it("exactly matches the bundled Codex Guardian prompt", () => {
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toHaveLength(13_473);
        expect(createHash("sha256").update(PERMISSION_REVIEW_INSTRUCTIONS).digest("hex")).toBe(
            "e455a9b4f059b0f2ab9bad7843f8c78a0cb7c273fc0c00764a9c4d5ac60d1ab2",
        );
    });
});
