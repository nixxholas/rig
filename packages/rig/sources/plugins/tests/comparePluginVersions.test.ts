import { describe, expect, it } from "vitest";

import { comparePluginVersions } from "../comparePluginVersions.js";

describe("comparing plugin versions", () => {
    it.each([
        ["1.0.0+a", "1.0.0+b", 0],
        ["1.0.0-alpha", "1.0.0", -1],
        ["1.0.0-2", "1.0.0-10", -1],
        ["1.0.0-1", "1.0.0-alpha", -1],
        ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ] as const)("%s compares to %s as %s", (left, right, expected) => {
        expect(comparePluginVersions(left, right)).toBe(expected);
    });
});
