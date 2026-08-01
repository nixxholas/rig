import { describe, expect, it } from "vitest";

import { createPermissionInstructions, createSubagentInstructions } from "./instructions.js";

describe("createSubagentInstructions", () => {
    it("adds the generic parent-handoff overlay", () => {
        const instructions = createSubagentInstructions("Base project instructions.", 1, 2);

        expect(instructions).toContain("Base project instructions.");
        expect(instructions).toContain("You are a subagent working on one delegated step.");
        expect(instructions).toContain("return a concise result to the parent agent");
    });

    it("replaces an existing provider overlay when a nested child changes model", () => {
        const parentInstructions = createSubagentInstructions("Base project instructions.", 1, 3);
        const codexInstructions = createSubagentInstructions(parentInstructions, 2, 3);

        expect(codexInstructions).toContain("Base project instructions.");
        expect(codexInstructions).toContain("You are a subagent working on one delegated step.");
        expect(codexInstructions.match(/You are a subagent working/gu)).toHaveLength(1);
        expect(codexInstructions.match(/at depth/gu)).toHaveLength(1);
    });
});

describe("createPermissionInstructions", () => {
    it("tells a restricted mode where sockets, credentials, and writes stop", () => {
        for (const mode of ["auto", "workspace_write", "read_only"] as const) {
            const instructions = createPermissionInstructions(mode);
            expect(instructions).toContain("Shell commands run in a sandbox with these limits:");
            expect(instructions).toContain("the Docker daemon or the SSH agent");
            expect(instructions).toContain("the keychain is unavailable");
            expect(instructions).toContain("binding a local TCP or UDP port is refused");
        }

        expect(createPermissionInstructions("workspace_write")).toContain(
            "Put any local unix socket inside the working directory",
        );
        expect(createPermissionInstructions("read_only")).toContain(
            "no local socket may be created",
        );
        expect(createPermissionInstructions("workspace_write")).not.toContain(
            "no local socket may be created",
        );
        expect(createPermissionInstructions("auto")).toContain(
            "request reviewed full-access execution for that one command",
        );
    });

    it("leaves Full access free of sandbox limits", () => {
        const instructions = createPermissionInstructions("full_access");

        expect(instructions).toBe(
            "You are in Full access mode. Filesystem, shell, and network access are unrestricted.",
        );
    });
});
