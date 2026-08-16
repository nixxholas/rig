import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getManagedProjectsDirectory } from "../../sources/modules/projects/getManagedProjectsDirectory.js";
import { getManagedWorkspacesDirectory } from "../../sources/modules/projects/getManagedWorkspacesDirectory.js";

describe("getManagedProjectsDirectory", () => {
    it("puts cloned projects beside the person's other Happy folders", () => {
        expect(getManagedProjectsDirectory({}, "/Users/person")).toBe(
            join("/Users/person", "Happy", "Projects"),
        );
    });

    it("honours an absolute override", () => {
        expect(
            getManagedProjectsDirectory(
                { RIG_PROJECTS_DIRECTORY: "/srv/projects" },
                "/Users/person",
            ),
        ).toBe("/srv/projects");
    });

    it("refuses a relative override rather than resolving it against an accidental directory", () => {
        expect(() =>
            getManagedProjectsDirectory({ RIG_PROJECTS_DIRECTORY: "projects" }, "/Users/person"),
        ).toThrow("must be an absolute path");
    });

    it("falls back to the real home directory", () => {
        expect(getManagedProjectsDirectory({})).toBe(join(homedir(), "Happy", "Projects"));
    });
});

describe("getManagedWorkspacesDirectory", () => {
    it("uses the capitalised layout on macOS and the lower-case one elsewhere", () => {
        const path = getManagedWorkspacesDirectory({}, "/Users/person");
        expect(path).toBe(
            process.platform === "darwin"
                ? join("/Users/person", "Happy", "Workspaces")
                : join("/Users/person", "happy", "workspaces"),
        );
    });

    it("honours an absolute override", () => {
        expect(
            getManagedWorkspacesDirectory(
                { RIG_WORKSPACES_DIRECTORY: "/srv/workspaces" },
                "/Users/person",
            ),
        ).toBe("/srv/workspaces");
    });

    it("refuses a relative override", () => {
        expect(() =>
            getManagedWorkspacesDirectory(
                { RIG_WORKSPACES_DIRECTORY: "workspaces" },
                "/Users/person",
            ),
        ).toThrow("must be an absolute path");
    });

    it("uses the platform it is told about, not only the one it runs on", () => {
        expect(getManagedWorkspacesDirectory({}, "/Users/person", "darwin")).toBe(
            join("/Users/person", "Happy", "Workspaces"),
        );
        expect(getManagedWorkspacesDirectory({}, "/home/person", "linux")).toBe(
            join("/home/person", "happy", "workspaces"),
        );
    });
});
