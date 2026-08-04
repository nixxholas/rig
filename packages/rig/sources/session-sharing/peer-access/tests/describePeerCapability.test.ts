import { describe, expect, it } from "vitest";

import type { PeerCapability } from "../types.js";
import {
    describePeerCapabilitiesActivePhrase,
    describePeerCapabilities,
    describePeerCapability,
    describePeerCapabilityDetail,
    describePeerCapabilityGrantWarning,
} from "../describePeerCapability.js";

describe("describePeerCapabilities", () => {
    it("says the friend can read the conversation only when they hold no capabilities", () => {
        expect(describePeerCapabilities([])).toBe("Read the conversation only");
    });
});

describe("describePeerCapability and describePeerCapabilityDetail", () => {
    it("never falls through to a raw capability code or an empty sentence for a capability this union can hold", () => {
        for (const capability of ["terminal_view"] as const) {
            expect(describePeerCapability(capability)).not.toBe(capability);
            expect(describePeerCapability(capability).length).toBeGreaterThan(0);
            expect(describePeerCapabilityDetail(capability).length).toBeGreaterThan(0);
        }
    });

    it("throws rather than silently naming an unhandled capability, so a widened union without a case fails loudly", () => {
        const unhandled = "something_new" as PeerCapability;
        expect(() => describePeerCapability(unhandled)).toThrow(/no english label/i);
        expect(() => describePeerCapabilityDetail(unhandled)).toThrow(/no detail sentence/i);
    });
});

describe("describePeerCapabilitiesActivePhrase", () => {
    it("is a grammatical verb phrase for one held capability", () => {
        expect(describePeerCapabilitiesActivePhrase(["terminal_view"])).toBe("watch a terminal");
    });

    it("is a grammatical verb phrase for no held capability at all", () => {
        expect(describePeerCapabilitiesActivePhrase([])).toBe(
            "do nothing beyond reading this session",
        );
    });
});

describe("describePeerCapabilityGrantWarning", () => {
    it("states both that what was already seen cannot be recalled and that credentials must be rotated", () => {
        const warning = describePeerCapabilityGrantWarning(["terminal_view"]);

        expect(warning).toMatch(/cannot recall/i);
        expect(warning.toLowerCase()).toContain("rotate");
    });
});
