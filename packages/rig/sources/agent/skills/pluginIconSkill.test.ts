import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../context/createNodeFileSystemContext.js";
import { loadSkillInstructions } from "./loadSkillInstructions.js";
import { loadSkills } from "./loadSkills.js";

const cleanup: string[] = [];

afterEach(async () => {
    await Promise.all(
        cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("bundled local plugin icon skill", () => {
    it("is offered automatically without writing a user skill folder", async () => {
        const home = await mkdtemp(join(process.cwd(), ".plugin-icon-skill-"));
        cleanup.push(home);
        const fs = createNodeFileSystemContext(process.cwd(), {
            home,
            permissionMode: () => "workspace_write",
        });

        const skills = await loadSkills(fs);
        const icon = skills.find((skill) => skill.name === "local-plugin-icon");
        expect(icon?.description).toContain("Automatically use");
        expect(icon?.filePath).not.toContain(home);
        expect(await loadSkillInstructions(fs)).toContain("<name>local-plugin-icon</name>");

        const body = await readFile(icon!.filePath, "utf8");
        expect(body).toContain("Jobs-era iPhone icons");
        expect(body).toContain("original");
        expect(body).toContain("fully decodable PNG");
        expect(body).toContain("Prefer the available image-generation tool");
        expect(body).toContain("Only when image generation is unavailable");
        expect(body).toContain("create the icon another way");
        expect(body).toContain("Do not use `qlmanage`");
        expect(body).toContain("nested macOS sandbox");
        await expect(
            readFile(join(home, ".agents", "skills", "local-plugin-icon", "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
});
