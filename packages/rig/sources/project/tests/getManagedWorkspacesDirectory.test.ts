import { describe, expect, it } from "vitest";

import { getManagedWorkspacesDirectory } from "../getManagedWorkspacesDirectory.js";

describe("getManagedWorkspacesDirectory", () => {
    it("uses the platform-preferred Happy directory capitalization", () => {
        expect(getManagedWorkspacesDirectory({}, "/Users/tester", "darwin")).toBe(
            "/Users/tester/Happy/Workspaces",
        );
        expect(getManagedWorkspacesDirectory({}, "/home/tester", "linux")).toBe(
            "/home/tester/happy/workspaces",
        );
    });

    it("honors an absolute RIG_WORKSPACES_DIRECTORY on every platform", () => {
        expect(
            getManagedWorkspacesDirectory(
                { RIG_WORKSPACES_DIRECTORY: "/srv/rig-workspaces" },
                "/home/tester",
                "linux",
            ),
        ).toBe("/srv/rig-workspaces");
    });

    it("rejects a relative RIG_WORKSPACES_DIRECTORY", () => {
        expect(() =>
            getManagedWorkspacesDirectory(
                { RIG_WORKSPACES_DIRECTORY: "relative/workspaces" },
                "/home/tester",
                "linux",
            ),
        ).toThrow("RIG_WORKSPACES_DIRECTORY must be an absolute path.");
    });
});
