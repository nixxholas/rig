import { describe, expect, it } from "vitest";

import { getGeneratedDirectory } from "./getGeneratedDirectory.js";

describe("getGeneratedDirectory", () => {
    it("uses the Happy user-data folder on each platform", () => {
        expect(getGeneratedDirectory({}, "/Users/tester", "darwin")).toBe(
            "/Users/tester/Happy/Generated",
        );
        expect(getGeneratedDirectory({}, "/home/tester", "linux")).toBe(
            "/home/tester/happy/generated",
        );
    });

    it("accepts an absolute override and rejects a relative one", () => {
        expect(
            getGeneratedDirectory(
                { HAPPY_GENERATED_DIRECTORY: "/shared/generated" },
                "/home/tester",
                "linux",
            ),
        ).toBe("/shared/generated");
        expect(() =>
            getGeneratedDirectory(
                { HAPPY_GENERATED_DIRECTORY: "generated" },
                "/home/tester",
                "linux",
            ),
        ).toThrow("HAPPY_GENERATED_DIRECTORY must be an absolute path");
    });
});
