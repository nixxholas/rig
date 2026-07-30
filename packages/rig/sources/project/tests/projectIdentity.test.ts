import { describe, expect, it } from "vitest";

import { projectNameKey, projectStorageKey, validateProjectName } from "../projectIdentity.js";

describe("project identity", () => {
    it("normalizes display identity and portable storage keys", () => {
        expect(projectNameKey("Ｒig")).toBe(projectNameKey("rig"));
        expect(projectStorageKey(" Café / API ")).toBe("cafe-api");
        expect(projectStorageKey("Привет мир")).toBe("privet-mir");
        expect(projectStorageKey("🚀")).toBe("project");
        expect(() => validateProjectName(" \u0000 ")).toThrow("control");
    });
});
