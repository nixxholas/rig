import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../context/createNodeFileSystemContext.js";
import { formatSkillsForPrompt } from "../formatSkillsForPrompt.js";
import { loadSkills } from "../loadSkills.js";

const cleanup: string[] = [];

afterEach(async () => {
    await Promise.all(
        cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("loadSkills", () => {
    it("keeps a file skill when a plugin supplies the same name and reports the collision", async () => {
        const root = await createRoot();
        const workspace = join(root, "workspace");
        const pluginRoot = join(root, "plugin-skills");
        await writeSkill(
            join(workspace, ".agents", "skills", "review"),
            "review",
            "Review the user's files.",
        );
        await writeSkill(pluginRoot, "review", "Review through the plugin.");
        const collisions: {
            kept: { source: { type: string } };
            skipped: { source: { type: string } };
        }[] = [];

        const skills = await loadSkills(createFileSystem(workspace), {
            additionalRoots: [
                {
                    path: pluginRoot,
                    source: { folder: "reviewer", plugin: "Reviewer", type: "plugin" },
                },
            ],
            onSkillCollision: (collision) => collisions.push(collision),
        });

        expect(skills.find((skill) => skill.name === "review")).toMatchObject({
            description: "Review the user's files.",
            source: { type: "file" },
        });
        expect(collisions).toEqual([
            {
                kept: expect.objectContaining({ source: { type: "file" } }),
                skipped: expect.objectContaining({
                    source: { folder: "reviewer", plugin: "Reviewer", type: "plugin" },
                }),
            },
        ]);
        expect(formatSkillsForPrompt(skills)).not.toContain("Plugin skill locations");
    });

    it("follows symlinked file skill folders but refuses and reports plugin symlinks", async () => {
        const root = await createRoot();
        const workspace = join(root, "workspace");
        const external = join(root, "external");
        const pluginRoot = join(root, "plugin-skills");
        const fileSkillTarget = join(external, "file-skill");
        const pluginSkillTarget = join(external, "plugin-skill");
        const fileSkillLink = join(workspace, ".agents", "skills", "file-skill");
        const pluginSkillLink = join(pluginRoot, "plugin-skill");
        await Promise.all([
            writeSkill(fileSkillTarget, "file-skill", "A symlinked file skill."),
            writeSkill(pluginSkillTarget, "plugin-skill", "A symlinked plugin skill."),
            mkdir(join(workspace, ".agents", "skills"), { recursive: true }),
            mkdir(pluginRoot, { recursive: true }),
        ]);
        await Promise.all([
            symlink(fileSkillTarget, fileSkillLink, "dir"),
            symlink(pluginSkillTarget, pluginSkillLink, "dir"),
        ]);
        const invalidPaths: string[] = [];

        const skills = await loadSkills(createFileSystem(workspace), {
            additionalRoots: [
                {
                    path: pluginRoot,
                    source: { folder: "linked", plugin: "Linked", type: "plugin" },
                },
            ],
            onInvalidSkill: (filePath) => invalidPaths.push(filePath),
        });

        expect(skills).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "file-skill", source: { type: "file" } }),
            ]),
        );
        expect(skills.some((skill) => skill.name === "plugin-skill")).toBe(false);
        expect(invalidPaths).toEqual([pluginSkillLink]);
    });
});

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(process.cwd(), ".load-skills-"));
    cleanup.push(root);
    return root;
}

function createFileSystem(workspace: string) {
    return createNodeFileSystemContext(workspace, {
        permissionMode: () => "full_access",
    });
}

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
}
