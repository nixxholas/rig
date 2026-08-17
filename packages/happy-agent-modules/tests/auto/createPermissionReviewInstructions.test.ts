import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
    createPermissionReviewInstructions,
    PERMISSION_REVIEW_INSTRUCTIONS,
} from "../../sources/auto/impl/createPermissionReviewInstructions.js";

describe("createPermissionReviewInstructions", () => {
    it("guardian_prompt_matches_v1_golden_bytes", () => {
        // The generated no-policy prompt must be byte-identical to the v1 guardian prompt, so the
        // reviewer reads exactly the same policy. These are the exact length and hash the v1
        // golden test asserts.
        expect(PERMISSION_REVIEW_INSTRUCTIONS).toHaveLength(13_473);
        expect(createHash("sha256").update(PERMISSION_REVIEW_INSTRUCTIONS).digest("hex")).toBe(
            "e455a9b4f059b0f2ab9bad7843f8c78a0cb7c273fc0c00764a9c4d5ac60d1ab2",
        );
    });

    it("appends a user security policy under the fixed stricter-wins heading", () => {
        const instructions = createPermissionReviewInstructions(
            "Treat releases to production as high risk.",
        );

        expect(instructions).toContain("Organization: default generic tenant.");
        expect(instructions).toContain("Treat releases to production as high risk.");
        expect(instructions).toContain("## User security policy");
        expect(instructions).toContain("follow whichever rule is stricter");
        expect(instructions).not.toContain("{{ tenant_policy_config }}");
    });

    it("uses only the built-in policy when the security policy is blank", () => {
        expect(createPermissionReviewInstructions("   \n  ")).toBe(PERMISSION_REVIEW_INSTRUCTIONS);
        expect(createPermissionReviewInstructions(undefined)).toBe(PERMISSION_REVIEW_INSTRUCTIONS);
    });

    it("preserves replacement-string metacharacters in user security policy text", () => {
        const policy = "literal $& marker $` prefix and $' suffix";
        const instructions = createPermissionReviewInstructions(policy);

        expect(instructions).toContain(policy);
    });
});
