import { describe, expect, it } from "vitest";

import {
    describePeerCapabilities,
    describePeerCapabilityGrantWarning,
} from "../describePeerCapability.js";

describe("describePeerCapabilities", () => {
    it("says the friend can read the conversation only when they hold no capabilities", () => {
        expect(describePeerCapabilities([])).toBe("Read the conversation only");
    });
});

describe("describePeerCapabilityGrantWarning", () => {
    it("states both that what was already seen cannot be recalled and that credentials must be rotated", () => {
        const warning = describePeerCapabilityGrantWarning(["terminal_view"]);

        expect(warning).toMatch(/cannot recall/i);
        expect(warning.toLowerCase()).toContain("rotate");
    });
});
