import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentsMdModule } from "../../sources/agentsMd/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";

const ctx = createRootContext().named("agents-md-module-test");
const scope = { agent: { id: "agent-a" } } as never;

function moduleFor(compute: FakeCompute): AgentsMdModule {
    return new AgentsMdModule({
        compute: { resolve: async () => compute },
    });
}

describe("AgentsMdModule", () => {
    it("discovers applicable files from the Git root to the compute cwd", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Use the project conventions.");
        compute.write("/workspace/packages/AGENTS.md", "Use package conventions.");
        compute.write("/workspace/other/AGENTS.md", "Not applicable.");
        const module = moduleFor(compute);

        expect(module.name).toBe("agents-md");
        expect("migrations" in module).toBe(false);
        await expect(module.read(ctx, "agent-a")).resolves.toEqual({
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
        expect(instructions).toContain(
            "# AGENTS.md instructions for /workspace/packages",
        );
        expect(instructions).not.toContain("Not applicable.");
    });

    it("exposes no tools and rejects malformed compute boundaries", () => {
        const compute = new FakeCompute();
        const module = moduleFor(compute);
        expect("tools" in module).toBe(false);
        expect(
            () => new AgentsMdModule({ compute: {} as never }),
        ).toThrow("AGENTS.md module options are invalid");
    });
});