import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PERMISSION_REVIEW_INSTRUCTIONS } from "./permissionReviewInstructions.js";

describe("permission review instructions", () => {
    it("exactly matches the bundled Codex Guardian prompt", () => {
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toHaveLength(13_452);
        expect(createHash("sha256").update(PERMISSION_REVIEW_INSTRUCTIONS).digest("hex")).toBe(
            "1dfbdd16ea4125a499042a416b5a241738fc7f515cff8ba932b6a8559a7fa79d",
        );
    });
});
