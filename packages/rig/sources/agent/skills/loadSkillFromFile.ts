import { basename, dirname, extname } from "node:path";

import type { FileSystemContext } from "../context/FileSystemContext.js";
import type { Skill, SkillSource } from "./Skill.js";
import type { SkillFrontmatter } from "./SkillFrontmatter.js";
import { isValidSkillDescription } from "./isValidSkillDescription.js";
import { isValidSkillName } from "./isValidSkillName.js";
import { parseSkillFrontmatter } from "./parseSkillFrontmatter.js";

export const MAXIMUM_SKILL_FILE_BYTES = 256 * 1024;

export async function loadSkillFromFile(
    fs: FileSystemContext,
    filePath: string,
    source: SkillSource = { type: "file" },
): Promise<Skill | undefined> {
    let content: string;
    try {
        content =
            source.type === "file"
                ? await fs.readFile(filePath)
                : Buffer.from(
                      await fs.readFileBuffer(filePath, {
                          maxBytes: MAXIMUM_SKILL_FILE_BYTES,
                          noFollow: true,
                      }),
                  ).toString("utf8");
    } catch {
        return undefined;
    }

    let frontmatter: SkillFrontmatter;
    try {
        frontmatter = parseSkillFrontmatter(content).frontmatter;
    } catch {
        return undefined;
    }

    const baseDir = dirname(filePath);
    const fallbackName =
        basename(filePath) === "SKILL.md"
            ? basename(baseDir)
            : basename(filePath, extname(filePath));
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : fallbackName;
    const description =
        typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;

    if (!isValidSkillName(name) || !isValidSkillDescription(description)) {
        return undefined;
    }

    return {
        name,
        description,
        filePath,
        baseDir,
        source,
    };
}
