import { describe, expect, it } from "vitest";

import {
    createAvailableModelsInstructions,
    createBundledDocsInstructions,
    createPermissionInstructions,
    createSubagentInstructions,
    createWorkspaceInstructions,
} from "./instructions.js";

describe("createWorkspaceInstructions", () => {
    it("ties workspaces to isolating parallel work, not to subtasks or reuse", () => {
        const instructions = createWorkspaceInstructions();

        expect(instructions).toContain("# Workspaces");
        expect(instructions).toContain("already lives in its own workspace");
        expect(instructions).toContain("one task, however many hands, is one workspace");
        expect(instructions).toContain("isolate work, not to organize it");
        expect(instructions).toContain("parallel tasks each get their own fresh workspace");
        expect(instructions).toContain("Do not create workspaces for subtasks");
        expect(instructions).toContain("Work in a workspace runs from inside that workspace");
        expect(instructions).toContain("reach into another workspace's folder by path");
        expect(instructions).toContain("A workspace is not free");
        expect(instructions).toContain("installs its own dependencies");
        expect(instructions).toContain(
            "A workspace created by another session is not yours to move into",
        );
        expect(instructions).toContain("ask the user first");
    });
});

describe("createBundledDocsInstructions", () => {
    it("points at the bundled docs path and scopes reading to questions about Rig and Happy", () => {
        const instructions = createBundledDocsInstructions("/happy/docs");

        expect(instructions).toContain("# Rig and Happy documentation");
        expect(instructions).toContain("`/happy/docs`");
        expect(instructions).toContain("read-only");
        expect(instructions).toContain("only when the user asks about Rig or Happy themselves");
        expect(instructions).toContain("not the current working directory");
    });

    it("points at the design specification for Happy applet and plugin UI work", () => {
        const instructions = createBundledDocsInstructions("/happy/docs");

        expect(instructions).toContain("`/happy/docs/DESIGN.md`");
        expect(instructions).toContain("design specification for Happy plugin apps and applets");
        expect(instructions).toContain("before designing or building a Happy applet or plugin UI");
    });
});

describe("createAvailableModelsInstructions", () => {
    it("lists selectable models without treating a bare model name as a delegation request", () => {
        const instructions = createAvailableModelsInstructions([
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "anthropic/sonnet-5",
                name: "Sonnet 5",
                providerId: "claude",
            },
        ]);

        expect(instructions).toContain("Sonnet 5");
        expect(instructions).not.toContain("bare model or family name");
        expect(instructions).not.toContain("usually means they want you to run that model");
    });
});

describe("createSubagentInstructions", () => {
    it("makes the child role and nested-delegation boundary explicit", () => {
        const instructions = createSubagentInstructions("Base project instructions.", 1, 2);

        expect(instructions).toContain("Base project instructions.");
        expect(instructions).toContain("You are a child subagent");
        expect(instructions).toContain("You are not the parent agent");
        expect(instructions).toContain("return a concise result to the parent agent");
        expect(instructions).toContain(
            "Do not spawn another subagent unless the parent explicitly instructed you",
        );
    });

    it("replaces an existing provider overlay when a nested child changes model", () => {
        const parentInstructions = createSubagentInstructions("Base project instructions.", 1, 3);
        const codexInstructions = createSubagentInstructions(parentInstructions, 2, 3);

        expect(codexInstructions).toContain("Base project instructions.");
        expect(codexInstructions).toContain("You are a child subagent");
        expect(codexInstructions.match(/You are a child subagent/gu)).toHaveLength(1);
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
