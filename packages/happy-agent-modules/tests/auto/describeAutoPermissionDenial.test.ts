import { describe, expect, it } from "vitest";

import { describeAutoPermissionDenial } from "../../sources/auto/impl/describeAutoPermissionDenial.js";
import type { AutoPermissionReview } from "../../sources/auto/impl/parseAutoPermissionReview.js";

const rejected: AutoPermissionReview = {
    decision: "deny",
    denialKind: "rejected",
    reason: "It exfiltrates credentials.",
    risk: "critical",
    userAuthorization: "unknown",
};

describe("describeAutoPermissionDenial", () => {
    it("states a reviewed refusal and forbids routing around it", () => {
        expect(describeAutoPermissionDenial("delete the vault", rejected)).toBe(
            "Automatic permission review refused delete the vault. " +
                "Reason: It exfiltrates credentials. " +
                "Do not pursue the same outcome by another route, by splitting it into smaller steps, or by " +
                "working around the restriction. Continue only with a materially safer alternative. " +
                "Otherwise stop and tell the user what you wanted to do and why it was refused, so they can " +
                "decide.",
        );
    });

    it("frames a timeout as unproven rather than unsafe", () => {
        expect(
            describeAutoPermissionDenial("delete the vault", { ...rejected, denialKind: "timed_out" }),
        ).toBe(
            "The automatic permission review did not finish in time, so delete the vault was not performed. " +
                "The action is unproven rather than unsafe, so do not treat the timeout by itself as a " +
                "verdict. You may try once more, or ask the user how to proceed.",
        );
    });

    it("frames an unavailable reviewer as no judgement about the action", () => {
        expect(
            describeAutoPermissionDenial("delete the vault", {
                ...rejected,
                denialKind: "unavailable",
            }),
        ).toBe(
            "The automatic permission review could not run, so delete the vault was not performed. " +
                "No judgement was made about the action itself. Continue with work that does not need " +
                "this permission, or ask the user how to proceed.",
        );
    });
});
