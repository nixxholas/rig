import { describe, expect, it } from "vitest";

import { getManagedProjectsDirectory } from "../getManagedProjectsDirectory.js";

describe("getManagedProjectsDirectory", () => {
    it("uses the Projects folder in the user's home directory", () => {
        expect(getManagedProjectsDirectory({}, "/Users/steve")).toBe("/Users/steve/Projects");
    });

    it("accepts only an absolute override", () => {
        expect(
            getManagedProjectsDirectory({ RIG_PROJECTS_DIRECTORY: "/srv/rig-projects" }, "/home"),
        ).toBe("/srv/rig-projects");
        expect(() =>
            getManagedProjectsDirectory({ RIG_PROJECTS_DIRECTORY: "projects" }, "/home"),
        ).toThrow("must be an absolute path");
    });
});
