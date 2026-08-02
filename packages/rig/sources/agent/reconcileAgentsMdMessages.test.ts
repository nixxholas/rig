import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENTS_MD_PROJECT_DOC_MAX_BYTES } from "./agentsMdProjectDocMaxBytes.js";
import { AGENTS_MD_REMOVAL_NOTICE, AGENTS_MD_REPLACEMENT_NOTICE } from "./agentsMdNotices.js";
import { AGENTS_MD_SPEC } from "./prompt/agentsMdSpec.js";
import { createNodeFileSystemContext } from "./context/createNodeFileSystemContext.js";
import { createSystemPrompt } from "./prompt/createSystemPrompt.js";
import { findLatestAgentsMdRecord } from "./findLatestAgentsMdRecord.js";
import { isInternalMessage } from "./isInternalMessage.js";
import { reconcileAgentsMdMessages } from "./reconcileAgentsMdMessages.js";
import type { Message, UserMessage } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "rig-agents-md-"));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, ".git"), "gitdir: elsewhere\n");
    return workspace;
}

function createFileSystem(workspace: string) {
    return createNodeFileSystemContext(workspace, {
        home: workspace,
        permissionMode: () => "workspace_write",
    });
}

function createIdFactory(): () => string {
    let counter = 0;
    return () => {
        counter += 1;
        return `agents-md-${counter}`;
    };
}

function userMessage(id: string, text: string): UserMessage {
    return { blocks: [{ type: "text", text }], id, role: "user" };
}

function textOf(message: Message): string {
    return message.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("reconcileAgentsMdMessages", () => {
    it("leads the conversation with project instructions instead of the system prompt", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const messages: readonly Message[] = [userMessage("user-1", "Fix the bug.")];

        const reconciled = await reconcileAgentsMdMessages({
            fs,
            idFactory: createIdFactory(),
            messages,
        });

        expect(reconciled).toHaveLength(2);
        const [instructions, first] = reconciled;
        expect(instructions?.role).toBe("user");
        expect(textOf(instructions!)).toContain("Always run the linter.");
        expect(textOf(instructions!)).toContain("# AGENTS.md instructions for");
        expect(first?.id).toBe("user-1");
    });

    it("keeps project instructions out of the system prompt", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);

        const prompt = await createSystemPrompt({
            context: { fs } as never,
            instructions: "You are rig.",
            messages: [],
            model: { id: "test-model" } as never,
            provider: { id: "test", type: "codex" } as never,
        });

        expect(prompt).not.toContain("Always run the linter.");
        expect(prompt).not.toContain("# AGENTS.md instructions");
    });

    it("keeps building the system prompt when the plugin skill catalog fails", async () => {
        const workspace = await createWorkspace();
        const fs = createFileSystem(workspace);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});

        const prompt = await createSystemPrompt({
            context: {
                fs,
                plugins: {
                    loadSkills: async () => {
                        throw new Error("plugins directory unavailable");
                    },
                },
            } as never,
            instructions: "You are rig.",
            messages: [],
            model: { id: "test-model" } as never,
            provider: { id: "test", type: "codex" } as never,
        });

        expect(prompt).toContain("You are rig.");
        expect(log).toHaveBeenCalledWith(
            "Rig could not load plugin skills; continuing without them: plugins directory unavailable",
        );
    });

    it("appends a plugin's static contribution to the composed system prompt", async () => {
        const workspace = await createWorkspace();
        const fs = createFileSystem(workspace);

        const prompt = await createSystemPrompt({
            context: {
                fs,
                plugins: {
                    loadSkills: async () => [],
                    loadSystemPrompt: async () => "Always annotate release notes with the owner.",
                },
            } as never,
            instructions: "You are rig.",
            messages: [],
            model: { id: "test-model" } as never,
            provider: { id: "test", type: "codex" } as never,
        });

        expect(prompt).toContain("You are rig.");
        expect(prompt).toContain("Always annotate release notes with the owner.");
    });

    it("tells every provider how to read the delivered project instructions", async () => {
        const workspace = await createWorkspace();
        const fs = createFileSystem(workspace);

        for (const type of ["claude", "codex", "grok"] as const) {
            const prompt = await createSystemPrompt({
                context: { fs } as never,
                instructions: "You are rig.",
                messages: [],
                model: { id: "test-model" } as never,
                provider: { id: type, type } as never,
            });

            expect(prompt).toContain(AGENTS_MD_SPEC);
        }
    });

    it("marks the record as internal so it is never shown as user-authored content", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);

        const reconciled = await reconcileAgentsMdMessages({
            fs,
            idFactory: createIdFactory(),
            messages: [],
        });

        expect(reconciled).toHaveLength(1);
        expect(isInternalMessage(reconciled[0]!)).toBe(true);
        expect(reconciled.filter((message) => !isInternalMessage(message))).toEqual([]);
    });

    it("reuses the identical record while the file is unchanged", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const idFactory = createIdFactory();

        const firstTurn = await reconcileAgentsMdMessages({ fs, idFactory, messages: [] });
        const secondTurn = await reconcileAgentsMdMessages({
            fs,
            idFactory,
            messages: [...firstTurn, userMessage("user-1", "Keep going.")],
        });
        const thirdTurn = await reconcileAgentsMdMessages({
            fs,
            idFactory,
            messages: [...secondTurn, userMessage("user-2", "And again.")],
        });

        const records = thirdTurn.filter((message) => isInternalMessage(message));
        expect(records).toHaveLength(1);
        expect(records[0]).toEqual(firstTurn[0]);
        expect(textOf(records[0]!)).toBe(textOf(firstTurn[0]!));
    });

    it("records the superseding instructions ahead of the request the user is waiting on", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const idFactory = createIdFactory();

        const firstTurn = await reconcileAgentsMdMessages({ fs, idFactory, messages: [] });
        await writeFile(join(workspace, "AGENTS.md"), "Always run the type checker.\n");

        const secondTurn = await reconcileAgentsMdMessages({
            fs,
            idFactory,
            messages: [...firstTurn, userMessage("user-1", "Switch to main.")],
        });

        expect(secondTurn.at(-1)?.id).toBe("user-1");
        expect(textOf(secondTurn.at(-1)!)).toBe("Switch to main.");
        expect(textOf(secondTurn.at(-2)!)).toContain(AGENTS_MD_REPLACEMENT_NOTICE);
    });

    it("appends a superseding record and preserves the original when the file changes", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const idFactory = createIdFactory();

        const firstTurn = await reconcileAgentsMdMessages({ fs, idFactory, messages: [] });
        const original = firstTurn[0]!;
        await writeFile(join(workspace, "AGENTS.md"), "Always run the type checker.\n");

        const secondTurn = await reconcileAgentsMdMessages({
            fs,
            idFactory,
            messages: [...firstTurn, userMessage("user-1", "Keep going.")],
        });

        expect(secondTurn).toHaveLength(3);
        expect(secondTurn[0]).toEqual(original);
        expect(textOf(secondTurn[0]!)).toContain("Always run the linter.");

        const replacement = secondTurn[1]!;
        expect(replacement.role).toBe("user");
        expect(isInternalMessage(replacement)).toBe(true);
        expect(textOf(replacement)).toContain(AGENTS_MD_REPLACEMENT_NOTICE);
        expect(textOf(replacement)).toContain("Always run the type checker.");
    });

    it("reports that deleted project instructions no longer apply", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const idFactory = createIdFactory();

        const firstTurn = await reconcileAgentsMdMessages({ fs, idFactory, messages: [] });
        await rm(join(workspace, "AGENTS.md"));

        const secondTurn = await reconcileAgentsMdMessages({
            fs,
            idFactory,
            messages: firstTurn,
        });

        expect(secondTurn).toHaveLength(2);
        expect(secondTurn[0]).toEqual(firstTurn[0]);
        expect(textOf(secondTurn[1]!)).toBe(AGENTS_MD_REMOVAL_NOTICE);
        expect(findLatestAgentsMdRecord(secondTurn)?.agentsMd.fingerprint).toBeNull();
    });

    it("records nothing when the project has no instructions", async () => {
        const workspace = await createWorkspace();
        const fs = createFileSystem(workspace);
        const messages: readonly Message[] = [userMessage("user-1", "Fix the bug.")];

        const reconciled = await reconcileAgentsMdMessages({
            fs,
            idFactory: createIdFactory(),
            messages,
        });

        expect(reconciled).toEqual(messages);
    });

    it("does not repeat the record when a stored conversation is resumed", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const idFactory = createIdFactory();

        const firstTurn = await reconcileAgentsMdMessages({ fs, idFactory, messages: [] });
        const stored = JSON.parse(JSON.stringify(firstTurn)) as readonly Message[];

        const resumed = await reconcileAgentsMdMessages({ fs, idFactory, messages: stored });

        expect(resumed).toEqual(stored);
        expect(resumed.filter((message) => isInternalMessage(message))).toHaveLength(1);
    });

    it("supersedes the stored record when the file changed while the session was closed", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "Always run the linter.\n");
        const fs = createFileSystem(workspace);
        const idFactory = createIdFactory();

        const firstTurn = await reconcileAgentsMdMessages({ fs, idFactory, messages: [] });
        const stored = JSON.parse(JSON.stringify(firstTurn)) as readonly Message[];
        await writeFile(join(workspace, "AGENTS.md"), "Always run the type checker.\n");

        const resumed = await reconcileAgentsMdMessages({ fs, idFactory, messages: stored });

        expect(resumed).toHaveLength(2);
        expect(resumed[0]).toEqual(stored[0]);
        expect(textOf(resumed[1]!)).toContain(AGENTS_MD_REPLACEMENT_NOTICE);
    });

    it("keeps the recorded instructions within the project document budget", async () => {
        const workspace = await createWorkspace();
        await writeFile(join(workspace, "AGENTS.md"), "A".repeat(64 * 1024));
        const fs = createFileSystem(workspace);

        const reconciled = await reconcileAgentsMdMessages({
            fs,
            idFactory: createIdFactory(),
            messages: [],
        });

        const recorded = textOf(reconciled[0]!);
        const body = recorded.slice(
            recorded.indexOf("<INSTRUCTIONS>\n") + "<INSTRUCTIONS>\n".length,
            recorded.lastIndexOf("\n</INSTRUCTIONS>"),
        );
        expect(Buffer.byteLength(body)).toBe(AGENTS_MD_PROJECT_DOC_MAX_BYTES);
    });
});
