import { describe, expect, it } from "vitest";

import {
    createCodexBedrockEnvironmentContext,
    createCodexCollaborationInstructions,
} from "./codexInstructions.js";

describe("createCodexCollaborationInstructions", () => {
    it("keeps Codex collaboration mechanics separate from the shared delegation policy", () => {
        const instructions = createCodexCollaborationInstructions({
            canSpawn: true,
            depth: 0,
            maxActive: 4,
        });

        expect(instructions).toContain("You are `/root`");
        expect(instructions).toContain("4 available concurrency slots");
        expect(instructions).toContain(
            "Every `spawn_agent` call states the child's `model` and `reasoning_effort`",
        );
        expect(instructions).toContain("only for work the user asked to run at that effort");
        expect(instructions).not.toContain("Do not spawn sub-agents unless the user");
        expect(instructions).not.toContain("Proactive multi-agent delegation is active");
    });

    it("gives child agents their parent handoff role", () => {
        const instructions = createCodexCollaborationInstructions({
            canSpawn: true,
            depth: 1,
            maxActive: 4,
        });

        expect(instructions).toContain("immediately delivered back to your parent agent");
        expect(instructions).not.toContain("Proactive multi-agent delegation is active");
        expect(instructions).toContain("cannot be called from inside `functions.exec`");
    });

    it("does not advertise spawning when the tool is unavailable", () => {
        const instructions = createCodexCollaborationInstructions({
            canSpawn: false,
            depth: 3,
            maxActive: 4,
        });

        expect(instructions).toContain("cannot spawn additional sub-agents at this depth");
        expect(instructions).toContain("immediately delivered back to your parent agent");
        expect(instructions).not.toContain("`spawn_agent`");
        expect(instructions).not.toContain("`reasoning_effort`");
    });
});

describe("createCodexBedrockEnvironmentContext", () => {
    it("escapes workspace values without changing the official XML shape", () => {
        const result = createCodexBedrockEnvironmentContext({
            fs: { cwd: '/workspace/a&b<"c">' },
            permissions: { mode: "workspace_write" },
        } as never);

        expect(result).toContain("<cwd>/workspace/a&amp;b&lt;&quot;c&quot;&gt;</cwd>");
        expect(result).toContain(
            "<workspace_roots><root>/workspace/a&amp;b&lt;&quot;c&quot;&gt;</root></workspace_roots>",
        );
        expect(result).toContain(
            '<permission_profile type="managed"><file_system type="restricted"><entry access="write"><path>/workspace/a&amp;b&lt;&quot;c&quot;&gt;</path></entry></file_system></permission_profile>',
        );
    });

    it("uses Codex's unrestricted profile for full access", () => {
        const result = createCodexBedrockEnvironmentContext({
            fs: { cwd: "/workspace" },
            permissions: { mode: "full_access" },
        } as never);

        expect(result).toContain(
            '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>',
        );
    });

    it("uses Codex's root-readable profile for read only", () => {
        const result = createCodexBedrockEnvironmentContext({
            fs: { cwd: "/workspace" },
            permissions: { mode: "read_only" },
        } as never);

        expect(result).toContain(
            '<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>',
        );
    });
});
