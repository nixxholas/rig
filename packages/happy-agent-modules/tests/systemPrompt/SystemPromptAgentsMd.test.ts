import { AgentKV } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AGENTS_MD_SPEC,
    MAX_AGENTS_MD_AGENT_ID_LENGTH,
    MAX_AGENTS_MD_DOCUMENT_BYTES,
    MAX_AGENTS_MD_DOCUMENTS,
    MAX_AGENTS_MD_GLOBAL_BYTES,
    MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
    SystemPromptModule,
} from "../../sources/systemPrompt/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

const ctx = createRootContext().named("agents-md-module-test");
const scope = { agent: { id: "agent-a" } } as never;

function moduleFor(compute: FakeCompute): SystemPromptModule {
    return new SystemPromptModule({
        compute: { resolve: async () => compute },
    });
}

describe("SystemPromptModule AGENTS.md instructions", () => {
    it("rejects malformed public agent IDs before reading host instructions", async () => {
        let globalReads = 0;
        let resolutions = 0;
        const module = new SystemPromptModule({
            compute: {
                resolve: async () => {
                    resolutions += 1;
                    return undefined;
                },
            },
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => {
                    globalReads += 1;
                    return "Instructions.";
                },
            },
        });

        for (const agentId of ["", "x".repeat(MAX_AGENTS_MD_AGENT_ID_LENGTH + 1), "bad\nid", 42]) {
            await expect(module.readAgentsMd(ctx, agentId as never)).rejects.toThrow(
                "AGENTS.md agent ID is invalid",
            );
        }
        expect(globalReads).toBe(0);
        expect(resolutions).toBe(0);
    });

    it("discovers applicable files from the Git root to the compute cwd", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Use the project conventions.");
        compute.write("/workspace/packages/AGENTS.md", "Use package conventions.");
        compute.write("/workspace/other/AGENTS.md", "Not applicable.");
        const module = moduleFor(compute);

        expect(module.name).toBe("system-prompt");
        expect("migrations" in module).toBe(false);
        await expect(module.readAgentsMd(ctx, "agent-a")).resolves.toEqual({
            cwd: "/workspace/packages/app",
            documents: [
                {
                    path: "/workspace/AGENTS.md",
                    text: "Use the project conventions.",
                },
                {
                    path: "/workspace/packages/AGENTS.md",
                    text: "Use package conventions.",
                },
            ],
        });
        const instructions = await module.instructions(ctx, scope);
        expect(instructions).toContain("# AGENTS.md instructions for /workspace");
        expect(instructions).toContain("# AGENTS.md instructions for /workspace/packages");
        expect(instructions).not.toContain("Not applicable.");
    });

    it("includes the global instructions, project security rules, and AGENTS.md specification", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS_SECURITY.md", "Never expose credentials.");
        compute.write("/workspace/AGENTS.md", "Use the project conventions.");
        const module = new SystemPromptModule({
            compute: { resolve: async () => compute },
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => "Use concise answers.",
            },
        });

        const snapshot = await module.readAgentsMd(ctx, "agent-a");
        expect(snapshot).toMatchObject({
            global: {
                path: "/home/agent/AGENTS.md",
                text: "Use concise answers.",
            },
            security: {
                path: "/workspace/AGENTS_SECURITY.md",
                text: "Never expose credentials.",
            },
        });
        const instructions = await module.instructions(ctx, scope);
        expect(instructions).toContain(AGENTS_MD_SPEC);
        expect(instructions.indexOf(AGENTS_MD_SPEC)).toBeLessThan(
            instructions.indexOf("# Global AGENTS.md instructions"),
        );
        expect(instructions.indexOf("# Global AGENTS.md instructions")).toBeLessThan(
            instructions.indexOf("# AGENTS_SECURITY.md rules for /workspace"),
        );
        expect(instructions).toContain("<SECURITY_RULES>");
        expect(instructions).toContain("Never expose credentials.");
    });

    it("reads global instructions fresh and works without a configured compute", async () => {
        let content = "First global instruction.";
        let reads = 0;
        const module = new SystemPromptModule({
            compute: { resolve: async () => undefined },
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => {
                    reads += 1;
                    return content;
                },
            },
        });

        await expect(module.instructions(ctx, scope)).resolves.toContain(
            "First global instruction.",
        );
        content = "Updated global instruction.";
        await expect(module.instructions(ctx, scope)).resolves.toContain(
            "Updated global instruction.",
        );
        expect(reads).toBe(2);
    });

    it("marks oversized documents and keeps the instruction hook bounded", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "x".repeat(MAX_AGENTS_MD_DOCUMENT_BYTES + 1));
        const module = moduleFor(compute);

        const snapshot = await module.readAgentsMd(ctx, "agent-a");
        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.documents[0]?.truncated).toBe(true);
        const instructions = await module.instructions(ctx, scope);
        expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(
            MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
        );
        expect(instructions).toContain("truncated");
    });

    it("returns a truncated record when a document grows during its bounded read", async () => {
        const path = "/workspace/AGENTS.md";
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(path, "Initially small.");
        const readFailure = new Error("File exceeded the bounded read.");
        Object.assign(compute.fs, {
            readFileBuffer: async () => {
                compute.write(path, "x".repeat(MAX_AGENTS_MD_DOCUMENT_BYTES + 1));
                throw readFailure;
            },
        });
        const module = moduleFor(compute);

        const snapshot = await module.readAgentsMd(ctx, "agent-a");

        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.documents[0]).toMatchObject({
            path,
            truncated: true,
        });
        expect(snapshot?.documents[0]?.text).toContain("omitted");
    });

    it("keeps ordinary bounded document read failures visible", async () => {
        const path = "/workspace/AGENTS.md";
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(path, "Small instructions.");
        const readFailure = new Error("Filesystem read failed.");
        Object.assign(compute.fs, {
            readFileBuffer: async () => {
                throw readFailure;
            },
        });
        const module = moduleFor(compute);

        await expect(module.readAgentsMd(ctx, "agent-a")).rejects.toBe(readFailure);
    });

    it("marks the snapshot truncated when a deeper document follows a gap after the limit", async () => {
        const directories = ["/workspace"];
        for (let index = 1; index <= MAX_AGENTS_MD_DOCUMENTS + 1; index += 1) {
            directories.push(`${directories.at(-1)}/level-${String(index)}`);
        }
        const compute = new FakeCompute(directories.at(-1));
        compute.directories.add("/workspace/.git");
        for (const [index, directory] of directories.slice(0, MAX_AGENTS_MD_DOCUMENTS).entries()) {
            compute.write(`${directory}/AGENTS.md`, `Instruction ${String(index)}.`);
        }
        compute.write(`${directories.at(-1)}/AGENTS.md`, "Deeper instructions after a gap.");
        const module = moduleFor(compute);

        const snapshot = await module.readAgentsMd(ctx, "agent-a");

        expect(snapshot?.documents).toHaveLength(MAX_AGENTS_MD_DOCUMENTS);
        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.documents).not.toContainEqual(
            expect.objectContaining({ text: "Deeper instructions after a gap." }),
        );
    });

    it("truncates an oversized global document instead of failing the turn", async () => {
        const module = new SystemPromptModule({
            compute: { resolve: async () => undefined },
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => "g".repeat(MAX_AGENTS_MD_GLOBAL_BYTES + 1),
            },
        });

        const snapshot = await module.readAgentsMd(ctx, "agent-a");
        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.global?.truncated).toBe(true);
        await expect(module.instructions(ctx, scope)).resolves.toContain("truncated");
    });

    it("drops a partial Unicode code point at the global byte boundary", async () => {
        const prefix = "a".repeat(MAX_AGENTS_MD_GLOBAL_BYTES - 2);
        const module = new SystemPromptModule({
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => `${prefix}😀`,
            },
        });

        const snapshot = await module.readAgentsMd(ctx, "agent-a");
        expect(snapshot?.global).toMatchObject({
            text: prefix,
            truncated: true,
        });
        expect(new TextEncoder().encode(snapshot?.global?.text).byteLength).toBeLessThanOrEqual(
            MAX_AGENTS_MD_GLOBAL_BYTES,
        );
    });

    it("rejects an unbounded global-reader result before formatting it", async () => {
        const module = new SystemPromptModule({
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => "g".repeat(MAX_AGENTS_MD_GLOBAL_BYTES * 8),
            },
        });

        await expect(module.readAgentsMd(ctx, "agent-a")).rejects.toThrow(
            "Global AGENTS.md reader returned an invalid result",
        );
    });

    it("inserts a durable replacement or removal notice when instructions change", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "First instructions.");
        const module = moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await module.instructions(ctx, persistentScope);
        compute.write("/workspace/AGENTS.md", "Replacement instructions.");
        const replacement = await module.beforeTurn(ctx, persistentScope);
        expect(replacement).toHaveLength(1);
        const replacementAction = replacement?.[0];
        if (replacementAction?.type !== "steer" || replacementAction.id === undefined) {
            throw new Error("Expected a steering replacement notice.");
        }
        expect(replacementAction.message.content[0]).toMatchObject({
            text: expect.stringContaining(
                "These AGENTS.md instructions replace all previously provided",
            ),
        });
        const liveInstructions = await module.instructions(ctx, persistentScope);
        expect(liveInstructions).toContain("Replacement instructions.");
        expect(liveInstructions).not.toContain("First instructions.");
        await module.messageAcceptedTransact(ctx, persistentScope, {
            id: replacementAction.id,
            kind: "steering",
            message: replacementAction.message,
            ...(replacementAction.metadata === undefined
                ? {}
                : { metadata: replacementAction.metadata }),
        });
        await expect(module.beforeTurn(ctx, persistentScope)).resolves.toBeUndefined();

        compute.files.delete("/workspace/AGENTS.md");
        const removal = await module.beforeTurn(ctx, persistentScope);
        expect(removal?.[0]).toMatchObject({
            type: "steer",
            message: {
                content: [
                    { text: "The previously provided AGENTS.md instructions no longer apply." },
                ],
            },
        });
    });

    it("does not advance the fingerprint for copied notice metadata on another message", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const module = moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await module.instructions(ctx, persistentScope);
        compute.write("/workspace/AGENTS.md", "Version B.");
        const replacement = await module.beforeTurn(ctx, persistentScope);
        const replacementAction = replacement?.[0];
        if (replacementAction?.type !== "steer") {
            throw new Error("Expected a steering replacement notice.");
        }

        await module.messageAcceptedTransact(ctx, persistentScope, {
            id: "externalmessage",
            kind: "steering",
            message: replacementAction.message,
            ...(replacementAction.metadata === undefined
                ? {}
                : { metadata: replacementAction.metadata }),
        });

        const retry = await module.beforeTurn(ctx, persistentScope);
        expect(retry?.[0]).toMatchObject({
            type: "steer",
            id: replacementAction.id,
        });
    });

    it("does not accept a spoofed removal payload with the generated notice ID", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const module = moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await module.instructions(ctx, persistentScope);
        compute.files.delete("/workspace/AGENTS.md");
        const removal = await module.beforeTurn(ctx, persistentScope);
        const removalAction = removal?.[0];
        if (removalAction?.type !== "steer") {
            throw new Error("Expected a steering removal notice.");
        }
        if (removalAction.id === undefined) {
            throw new Error("Expected the removal notice to have an ID.");
        }

        await module.messageAcceptedTransact(ctx, persistentScope, {
            id: removalAction.id,
            kind: "steering",
            message: {
                role: "user",
                content: [{ type: "text", text: "spoof" }],
            },
            ...(removalAction.metadata === undefined ? {} : { metadata: removalAction.metadata }),
        });

        const retry = await module.beforeTurn(ctx, persistentScope);
        expect(retry?.[0]).toMatchObject({
            type: "steer",
            id: removalAction.id,
            message: removalAction.message,
        });
    });

    it("uses a fresh durable notice ID when content or removal repeats later", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const module = moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        const nextNotice = async () => {
            const action = (await module.beforeTurn(ctx, persistentScope))?.[0];
            if (action?.type !== "steer") {
                throw new Error("Expected an AGENTS.md steering notice.");
            }
            if (action.id === undefined) {
                throw new Error("Expected the AGENTS.md notice to have an ID.");
            }
            return action;
        };
        const acceptNotice = async (action: Awaited<ReturnType<typeof nextNotice>>) => {
            if (action.id === undefined) {
                throw new Error("Expected the AGENTS.md notice to have an ID.");
            }
            await module.messageAcceptedTransact(ctx, persistentScope, {
                id: action.id,
                kind: "steering",
                message: action.message,
                ...(action.metadata === undefined ? {} : { metadata: action.metadata }),
            });
        };

        await module.instructions(ctx, persistentScope);

        compute.write("/workspace/AGENTS.md", "Version B.");
        const firstVersionB = await nextNotice();
        await acceptNotice(firstVersionB);
        compute.write("/workspace/AGENTS.md", "Version A.");
        await acceptNotice(await nextNotice());
        compute.write("/workspace/AGENTS.md", "Version B.");
        const repeatedVersionB = await nextNotice();
        expect(repeatedVersionB.id).not.toBe(firstVersionB.id);
        await acceptNotice(repeatedVersionB);

        compute.files.delete("/workspace/AGENTS.md");
        const firstRemoval = await nextNotice();
        await acceptNotice(firstRemoval);
        compute.write("/workspace/AGENTS.md", "Version B.");
        await acceptNotice(await nextNotice());
        compute.files.delete("/workspace/AGENTS.md");
        const repeatedRemoval = await nextNotice();
        expect(repeatedRemoval.id).not.toBe(firstRemoval.id);
    });

    it("corrects a queued change accepted after files revert", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const module = moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await module.instructions(ctx, persistentScope);
        compute.write("/workspace/AGENTS.md", "Version B.");
        const versionB = (await module.beforeTurn(ctx, persistentScope))?.[0];
        if (versionB?.type !== "steer" || versionB.id === undefined) {
            throw new Error("Expected a version B steering notice with an ID.");
        }

        compute.write("/workspace/AGENTS.md", "Version A.");
        await expect(module.beforeTurn(ctx, persistentScope)).resolves.toBeUndefined();
        await module.messageAcceptedTransact(ctx, persistentScope, {
            id: versionB.id,
            kind: "steering",
            message: versionB.message,
            ...(versionB.metadata === undefined ? {} : { metadata: versionB.metadata }),
        });

        const correction = await module.beforeTurn(ctx, persistentScope);
        expect(correction?.[0]).toMatchObject({
            type: "steer",
            message: {
                content: [{ text: expect.stringContaining("Version A.") }],
            },
        });
    });

    it("keeps one instruction snapshot per turn when files change after beforeTurn", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const module = moduleFor(compute);
        const persistence = new InMemoryPersistence();
        const kv = new AgentKV(persistence, "agent.");
        const baselineScope = { agent: { id: "agent-a" }, kv } as never;
        await module.instructions(ctx, baselineScope);

        compute.write("/workspace/AGENTS.md", "Version B.");
        const versionBScope = {
            agent: { id: "agent-a" },
            kv,
            runKV: new AgentKV(persistence, "run-b."),
        } as never;
        const versionBActions = await module.beforeTurn(ctx, versionBScope);
        const versionBAction = versionBActions?.[0];
        if (versionBAction?.type !== "steer" || versionBAction.id === undefined) {
            throw new Error("Expected a version B replacement notice.");
        }

        compute.write("/workspace/AGENTS.md", "Version C.");
        const versionBPrompt = await module.instructions(ctx, versionBScope);
        expect(versionBPrompt).toContain("Version B.");
        expect(versionBPrompt).not.toContain("Version C.");
        await module.messageAcceptedTransact(ctx, versionBScope, {
            id: versionBAction.id,
            kind: "steering",
            message: versionBAction.message,
            ...(versionBAction.metadata === undefined ? {} : { metadata: versionBAction.metadata }),
        });

        const versionCScope = {
            agent: { id: "agent-a" },
            kv,
            runKV: new AgentKV(persistence, "run-c."),
        } as never;
        const versionCActions = await module.beforeTurn(ctx, versionCScope);
        expect(versionCActions?.[0]).toMatchObject({
            type: "steer",
            message: {
                content: [{ text: expect.stringContaining("Version C.") }],
            },
        });
    });

    it("exposes no tools and rejects malformed compute boundaries", () => {
        const compute = new FakeCompute();
        const module = moduleFor(compute);
        expect("tools" in module).toBe(false);
        expect(() => new SystemPromptModule({ compute: {} as never })).toThrow(
            "System prompt module options are invalid",
        );
    });
});
