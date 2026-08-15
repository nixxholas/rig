import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { SkillsModule } from "../../sources/skills/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";

const ctx = createRootContext().named("skills-module-test");
const agentId = "agent-a";
const scope = { agent: { id: agentId } } as never;

function skill(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function moduleFor(compute: FakeCompute): SkillsModule {
    return new SkillsModule({
        compute: { resolve: async () => compute },
    });
}

describe("SkillsModule", () => {
    it("discovers user and project skills with deeper project precedence", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/home/agent/.agents/skills/review/SKILL.md",
            skill("review", "User review.", "User instructions."),
        );
        compute.write(
            "/workspace/.agents/skills/categories/build/SKILL.md",
            skill("build", "Build the project.", "Root build instructions."),
        );
        compute.write(
            "/workspace/packages/.agents/skills/review/SKILL.md",
            skill("review", "Package review.", "Package instructions.").replaceAll(
                "\n",
                "\r\n",
            ),
        );
        compute.write(
            "/workspace/.agents/skills/broken/SKILL.md",
            "x".repeat(300_000),
        );
        compute.write(
            "/workspace/.agents/skills/large/SKILL.md",
            skill("large", "Large valid skill.", "x".repeat(20_000)),
        );
        const module = moduleFor(compute);

        expect(module.name).toBe("skills");
        expect("migrations" in module).toBe(false);
        await expect(module.list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Build the project.",
                    location: "/workspace/.agents/skills/categories/build/SKILL.md",
                    name: "build",
                    source: "project",
                },
                {
                    description: "Large valid skill.",
                    location: "/workspace/.agents/skills/large/SKILL.md",
                    name: "large",
                    source: "project",
                },
                {
                    description: "Package review.",
                    location: "/workspace/packages/.agents/skills/review/SKILL.md",
                    name: "review",
                    source: "project",
                },
            ],
        });
        await expect(
            module.read(ctx, agentId, { name: "review" }),
        ).resolves.toMatchObject({
            content: expect.stringContaining("Package instructions."),
            name: "review",
        });
        expect(await module.instructions(ctx, scope)).toContain(
            "<description>Package review.</description>",
        );
        const firstPage = await module.list(ctx, agentId, { limit: 1 });
        expect(firstPage.nextCursor).toBe("1");
        const cursor = firstPage.nextCursor;
        if (cursor === undefined) throw new Error("Expected a second skill page.");
        await expect(
            module.list(ctx, agentId, { cursor, limit: 1 }),
        ).resolves.toMatchObject({
            skills: [{ name: "large" }],
        });
    });

    it("follows symlinked skill directories without looping", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.directories.add("/workspace/.agents/skills");
        compute.directories.add("/external/shared-skill");
        compute.write(
            "/external/shared-skill/SKILL.md",
            skill("shared", "Shared skill.", "Shared instructions."),
        );
        compute.links.set(
            "/workspace/.agents/skills/shared",
            "/external/shared-skill",
        );
        compute.links.set(
            "/external/shared-skill/loop",
            "/workspace/.agents/skills/shared",
        );
        const module = moduleFor(compute);
        await expect(module.list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ name: "shared" }],
        });
    });

    it("bounds system instructions for a large valid catalog", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        for (let index = 0; index < 120; index += 1) {
            const name = `skill-${String(index).padStart(3, "0")}`;
            compute.write(
                `/workspace/.agents/skills/${name}/SKILL.md`,
                skill(name, "d".repeat(1_000), "Instructions."),
            );
        }
        const module = moduleFor(compute);
        const instructions = await module.instructions(ctx, scope);
        expect(instructions.length).toBeLessThanOrEqual(100_000);
        expect(instructions).toContain("<available_skills>");
        expect(instructions).toContain("</available_skills>");
    });

    it("exposes skill tools and rejects malformed compute boundaries", async () => {
        const compute = new FakeCompute();
        const module = moduleFor(compute);
        expect((await module.tools(ctx, scope)).map((tool) => tool.name)).toEqual([
            "list_skills",
            "read_skill",
        ]);
        expect(
            () => new SkillsModule({ compute: {} as never }),
        ).toThrow("Skills module options are invalid");
    });
});