import { describe, expect, it } from "vitest";

import { parseAutoPermissionReview } from "./parseAutoPermissionReview.js";

describe("parseAutoPermissionReview", () => {
    it("reads the structured verdict Codex Guardian is told to produce", () => {
        const review = parseAutoPermissionReview(
            '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Routine local edit."}',
        );

        expect(review).toEqual({
            decision: "allow",
            reason: "Routine local edit.",
            risk: "low",
            userAuthorization: "high",
        });
    });

    it("accepts the same thin surrounding-prose recovery as Codex Guardian", () => {
        expect(
            parseAutoPermissionReview(
                'Assessment: {"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Routine local edit."}',
            ),
        ).toEqual({
            decision: "allow",
            risk: "low",
            userAuthorization: "high",
            reason: "Routine local edit.",
        });
    });

    it("uses Codex Guardian defaults for omitted assessment details", () => {
        expect(parseAutoPermissionReview('{"outcome":"allow"}')).toEqual({
            decision: "allow",
            risk: "low",
            userAuthorization: "unknown",
            reason: "Auto-review returned a low-risk allow decision.",
        });
    });

    it("rejects unknown outcomes", () => {
        expect(
            parseAutoPermissionReview(
                '{"outcome":"escalate","risk_level":"high","user_authorization":"low","rationale":"Not supported."}',
            ),
        ).toBeUndefined();
        expect(
            parseAutoPermissionReview(
                '{"outcome":"allow","risk_level":"extreme","user_authorization":"high"}',
            ),
        ).toBeUndefined();
    });
});
