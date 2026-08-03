import { describe, expect, it } from "vitest";

import { createShareId, shareKindOf, type ShareKind } from "../shareId.js";

describe("share identifiers", () => {
    it("round-trips every kind through its own identifier", () => {
        const kinds: readonly ShareKind[] = ["session", "workspace", "project"];
        for (const kind of kinds) {
            expect(shareKindOf(createShareId(kind))).toBe(kind);
        }
    });

    it("gives a workspace and a project distinguishable prefixes", () => {
        expect(createShareId("workspace")).toMatch(/^wsp_[a-z0-9]+$/);
        expect(createShareId("project")).toMatch(/^prj_[a-z0-9]+$/);
    });

    it("leaves a session share unprefixed so existing identifiers keep working", () => {
        const shareId = createShareId("session");
        expect(shareId).toMatch(/^[a-z0-9]+$/);
        expect(shareKindOf(shareId)).toBe("session");
    });

    it("reads an identifier minted before scope sharing existed as a session share", () => {
        expect(shareKindOf("k7m2q9x4c8b1n5v3z6a0d2f7")).toBe("session");
    });

    it("mints a fresh identifier every time", () => {
        expect(createShareId("workspace")).not.toBe(createShareId("workspace"));
    });
});
