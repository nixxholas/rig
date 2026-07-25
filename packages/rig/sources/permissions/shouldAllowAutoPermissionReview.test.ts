import { describe, expect, it } from "vitest";

import { shouldAllowAutoPermissionReview } from "./shouldAllowAutoPermissionReview.js";

describe("shouldAllowAutoPermissionReview", () => {
    it.each([
        ["low", "low", true],
        ["low", "unknown", true],
        ["medium", "low", true],
        ["medium", "unknown", true],
        ["high", "unknown", false],
        ["high", "low", false],
        ["high", "medium", true],
        ["high", "high", true],
        ["critical", "high", false],
        ["critical", "medium", false],
    ] as const)(
        "treats %s risk with %s authorization as allowed=%s",
        (risk, userAuthorization, allowed) => {
            expect(
                shouldAllowAutoPermissionReview({
                    decision: "allow",
                    reason: "Reviewed.",
                    risk,
                    userAuthorization,
                }),
            ).toBe(allowed);
        },
    );

    it("preserves an explicit ask decision", () => {
        expect(
            shouldAllowAutoPermissionReview({
                decision: "deny",
                reason: "Needs confirmation.",
                risk: "low",
                userAuthorization: "high",
            }),
        ).toBe(false);
    });
});
