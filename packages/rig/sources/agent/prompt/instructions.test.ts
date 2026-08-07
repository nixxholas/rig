import { describe, expect, it } from "vitest";

import {
    createAvailableModelsInstructions,
    createBundledDocsInstructions,
    createParentDelegationInstructions,
    createPermissionInstructions,
    createSubagentInstructions,
    createWorkspaceInstructions,
} from "./instructions.js";

describe("createParentDelegationInstructions", () => {
    it("explicitly permits useful delegation without encouraging simple handoffs", () => {
        const instructions = createParentDelegationInstructions();

        expect(instructions).toContain("You are the parent agent");
        expect(instructions).toContain("explicitly allowed to spawn subagents");
        expect(instructions).toContain("Do simple work directly");
    });
});

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

    it("points at the design specification for Happy webapp and plugin UI work", () => {
        const instructions = createBundledDocsInstructions("/happy/docs");

        expect(instructions).toContain("`/happy/docs/DESIGN.md`");
        expect(instructions).toContain("design specification for Happy plugin apps and webapps");
        expect(instructions).toContain("before designing or building a Happy webapp or plugin UI");
    });
});

describe("what a model can search", () => {
    const models = [
        {
            defaultEffort: "medium",
            effortLevels: ["low", "high"],
            id: "xai/grok-4.5",
            name: "Grok 4.5",
            providerId: "grok",
            providerType: "grok",
        },
        {
            defaultEffort: "medium",
            effortLevels: ["low", "high"],
            id: "anthropic/opus-5",
            name: "Opus 5 1M",
            providerId: "claude",
            providerType: "claude",
        },
        {
            defaultEffort: "medium",
            effortLevels: ["low", "high"],
            id: "anthropic/opus-5",
            name: "Opus 5 1M",
            providerId: "bedrock",
            providerType: "bedrock",
        },
    ];

    /**
     * Search is a tool Rig runs, not a property of a backend: a model whose own endpoint cannot
     * search reaches one that can. Noting it per model would say some models cannot search, and an
     * agent that believes that delegates a search it could have run itself.
     */
    it("says every model can search, rather than marking some of them as able to", () => {
        const instructions = createAvailableModelsInstructions(models) ?? "";
        expect(instructions).toContain("Every model listed here can search the web and X");
        for (const line of instructions.split("\n").filter((line) => line.startsWith("- "))) {
            expect(line).not.toContain("searches");
        }
    });

    /**
     * Worth its own sentence: an agent that believes it cannot reach X will fetch an x.com page,
     * be refused by the site, and spend the turn finding that out.
     */
    it("says searching is the only way to read X", () => {
        const instructions = createAvailableModelsInstructions(models) ?? "";
        expect(instructions).toContain("the only way to read posts on X");
    });

    /** Nothing configured reads X, so the prompt must not promise it. */
    it("does not claim a search nothing configured can serve", () => {
        const webOnly = models.filter((model) => model.providerType !== "grok");
        const instructions = createAvailableModelsInstructions(webOnly) ?? "";
        expect(instructions).toContain("can search the web");
        expect(instructions).not.toContain("X");
    });

    /**
     * A search reaches the network without the shell, which is easy to mistake for being exempt
     * from permission. It is not: the tool still leaves the sandbox, so the note has to say the
     * search needs Auto or Full access rather than implying it runs regardless of mode.
     */
    it("says a search skips the shell but still needs permission to leave the sandbox", () => {
        const instructions = createAvailableModelsInstructions(models) ?? "";
        expect(instructions).toContain("reaches the network without the shell");
        expect(instructions).toContain("needs Auto or Full access");
        expect(instructions).not.toContain("is not affected by the sandbox");
    });

    it("says nothing about searching when no model can", () => {
        const instructions =
            createAvailableModelsInstructions(models.filter((m) => m.providerType === "bedrock")) ??
            "";
        expect(instructions).not.toContain("searches");
        expect(instructions).not.toContain("Auto or Full access");
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
