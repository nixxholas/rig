import { describe, expect, it } from "vitest";

import { parseAutoPermissionReview } from "../../sources/auto/impl/parseAutoPermissionReview.js";

describe("parseAutoPermissionReview", () => {
    it("reads the structured verdict the guardian is told to produce", () => {
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

    it("accepts the same thin surrounding-prose recovery as the guardian", () => {
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

    it("uses guardian defaults for omitted assessment details", () => {
        expect(parseAutoPermissionReview('{"outcome":"allow"}')).toEqual({
            decision: "allow",
            risk: "low",
            userAuthorization: "unknown",
            reason: "Auto-review returned a low-risk allow decision.",
        });
    });

    it("defaults an omitted deny rationale and risk to the deny values", () => {
        expect(parseAutoPermissionReview('{"outcome":"deny"}')).toEqual({
            decision: "deny",
            denialKind: "rejected",
            risk: "high",
            userAuthorization: "unknown",
            reason: "Auto-review returned a deny decision without a rationale.",
        });
    });

    it("collapses whitespace and caps an overlong rationale at 240 characters", () => {
        const rationale = `${"word ".repeat(80)}tail`;
        const review = parseAutoPermissionReview(
            JSON.stringify({ outcome: "deny", rationale }),
        );

        // v1 keeps 237 characters plus the single-character ellipsis, so the cap is 238 total.
        expect(review?.reason).toHaveLength(238);
        expect(review?.reason.endsWith("…")).toBe(true);
        expect(review?.reason).not.toContain("  ");
    });

    it("rejects unknown outcomes and unknown supplied classifications", () => {
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
        expect(
            parseAutoPermissionReview('{"outcome":"allow","user_authorization":"total"}'),
        ).toBeUndefined();
        expect(
            parseAutoPermissionReview('{"outcome":"allow","rationale":42}'),
        ).toBeUndefined();
    });

    it("returns undefined for unreadable guardian text", () => {
        expect(parseAutoPermissionReview("no json here")).toBeUndefined();
        expect(parseAutoPermissionReview("")).toBeUndefined();
    });
});
