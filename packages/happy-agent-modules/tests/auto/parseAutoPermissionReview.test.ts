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
        const review = parseAutoPermissionReview(JSON.stringify({ outcome: "deny", rationale }));

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
        expect(parseAutoPermissionReview('{"outcome":"allow","rationale":42}')).toBeUndefined();
    });

    it("returns undefined for unreadable guardian text", () => {
        expect(parseAutoPermissionReview("no json here")).toBeUndefined();
        expect(parseAutoPermissionReview("")).toBeUndefined();
    });

    it("uses defaults for blank and whitespace-only rationales", () => {
        expect(
            parseAutoPermissionReview(
                '{"outcome":"allow","rationale":" \\n\\t ","risk_level":"medium"}',
            ),
        ).toEqual({
            decision: "allow",
            risk: "medium",
            userAuthorization: "unknown",
            reason: "Auto-review returned a low-risk allow decision.",
        });
        expect(
            parseAutoPermissionReview(
                '{"outcome":"deny","rationale":" \\n\\t ","user_authorization":"low"}',
            ),
        ).toEqual({
            decision: "deny",
            denialKind: "rejected",
            risk: "high",
            userAuthorization: "low",
            reason: "Auto-review returned a deny decision without a rationale.",
        });
    });

    it("normalizes all whitespace runs in a rationale", () => {
        expect(
            parseAutoPermissionReview(
                JSON.stringify({
                    outcome: "deny",
                    rationale: "first\u000bsecond\u00a0third\nfourth",
                }),
            )?.reason,
        ).toBe("first second third fourth");
    });

    it("handles null and non-object JSON as unreadable decisions", () => {
        for (const text of ["null", "[]", "42", '"text"', "true", `{"outcome":null}`]) {
            expect(parseAutoPermissionReview(text)).toBeUndefined();
        }
    });

    it("rejects a wrapped object with no closing brace", () => {
        expect(
            parseAutoPermissionReview(
                'Assessment: {"outcome":"allow","rationale":"missing closing brace"',
            ),
        ).toBeUndefined();
    });

    it("uses the first opening and last closing brace for thin recovery", () => {
        expect(
            parseAutoPermissionReview('Assessment: {"outcome":"allow"} trailing {"broken"'),
        ).toEqual({
            decision: "allow",
            risk: "low",
            userAuthorization: "unknown",
            reason: "Auto-review returned a low-risk allow decision.",
        });
    });

    it("keeps a rationale at the cap and truncates one beyond it", () => {
        const atCap = "a".repeat(240);
        const overCap = "b".repeat(241);

        expect(
            parseAutoPermissionReview(JSON.stringify({ outcome: "deny", rationale: atCap }))
                ?.reason,
        ).toBe(atCap);
        expect(
            parseAutoPermissionReview(JSON.stringify({ outcome: "deny", rationale: overCap }))
                ?.reason,
        ).toBe(`${"b".repeat(237)}…`);
    });
});
