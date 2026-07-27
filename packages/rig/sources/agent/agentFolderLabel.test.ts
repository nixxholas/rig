import { describe, expect, it } from "vitest";

import { agentFolderLabel } from "./agentFolderLabel.js";

describe("agentFolderLabel", () => {
    it("uses a portable folder name instead of a container-local path", () => {
        expect(agentFolderLabel("/home/one/projects/rig")).toBe("rig");
        expect(agentFolderLabel("/workspace")).toBe("workspace");
        expect(agentFolderLabel("/")).toBe("/");
    });
});
