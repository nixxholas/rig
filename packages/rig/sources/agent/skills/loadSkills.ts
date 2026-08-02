import type { FileSystemContext } from "../context/FileSystemContext.js";
import type { Skill, SkillRoot } from "./Skill.js";
import { findSkillFilePaths } from "./findSkillFilePaths.js";
import { findSkillRootPaths } from "./findSkillRootPaths.js";
import { loadSkillFromFile } from "./loadSkillFromFile.js";

export interface LoadSkillsOptions {
    additionalRoots?: readonly SkillRoot[];
    onInvalidSkill?: (filePath: string, root: SkillRoot) => void;
    onSkillCollision?: (collision: { kept: Skill; skipped: Skill }) => void;
}

export async function loadSkills(
    fs: FileSystemContext,
    options: LoadSkillsOptions = {},
): Promise<readonly Skill[]> {
    const skillMap = new Map<string, Skill>();
    const roots: SkillRoot[] = [
        ...(options.additionalRoots ?? []),
        ...(await findSkillRootPaths(fs)).map((path) => ({
            path,
            source: { type: "file" as const },
        })),
    ];

    for (const root of roots) {
        const filePaths = await findSkillFilePaths(fs, root.path, {
            ...(root.source.type === "plugin" ? { refuseSymbolicLinks: true } : {}),
            onInvalidSkill: (filePath) => options.onInvalidSkill?.(filePath, root),
        });
        for (const filePath of filePaths) {
            const skill = await loadSkillFromFile(fs, filePath, root.source);
            if (skill === undefined) {
                options.onInvalidSkill?.(filePath, root);
                continue;
            }

            const existing = skillMap.get(skill.name);
            if (existing === undefined) {
                skillMap.set(skill.name, skill);
                continue;
            }

            const kept =
                existing.source.type === "file" && skill.source.type === "plugin"
                    ? existing
                    : skill;
            const skipped = kept === skill ? existing : skill;
            if (existing.source.type === "plugin" || skill.source.type === "plugin") {
                options.onSkillCollision?.({ kept, skipped });
            }
            skillMap.set(skill.name, kept);
        }
    }

    return [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}
