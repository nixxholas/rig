import { describe, expect, it } from "vitest";

import {
    createGeneratedMediaLocation,
    resolveGeneratedMediaLocation,
} from "./GeneratedMediaLocation.js";

describe("GeneratedMediaLocation", () => {
    it("creates and resolves a Rig-scoped generated-media locator", () => {
        expect(createGeneratedMediaLocation("preview.png")).toBe("generated/preview.png");
        expect(resolveGeneratedMediaLocation("generated/preview.png", "/host/generated")).toBe(
            "/host/generated/preview.png",
        );
    });

    it.each([
        "/host/generated/preview.png",
        "generated/../secret",
        "generated/nested/preview.png",
        "workspace/preview.png",
    ])("does not resolve an invalid generated-media locator: %s", (location) => {
        expect(resolveGeneratedMediaLocation(location, "/host/generated")).toBeUndefined();
    });
});
