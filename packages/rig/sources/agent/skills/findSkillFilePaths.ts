import { join } from "node:path";

import type { FileSystemContext } from "../context/FileSystemContext.js";

const SKILL_FILENAME = "SKILL.md";

export interface FindSkillFilePathsOptions {
    onInvalidSkill?: (path: string) => void;
    refuseSymbolicLinks?: boolean;
}

export async function findSkillFilePaths(
    fs: FileSystemContext,
    root: string,
    options: FindSkillFilePathsOptions = {},
): Promise<readonly string[]> {
    const paths: string[] = [];
    await collectSkillFilePaths(fs, root, paths, options);
    return paths;
}

async function collectSkillFilePaths(
    fs: FileSystemContext,
    dir: string,
    paths: string[],
    options: FindSkillFilePathsOptions,
): Promise<void> {
    const skillFile = join(dir, SKILL_FILENAME);
    try {
        const skillInfo =
            options.refuseSymbolicLinks === true
                ? await fs.lstat(skillFile)
                : await fs.stat(skillFile);
        if (skillInfo.isSymbolicLink && options.refuseSymbolicLinks === true) {
            options.onInvalidSkill?.(skillFile);
        } else if (skillInfo.isFile) {
            paths.push(skillFile);
            return;
        }
    } catch {
        // A missing or unreadable SKILL.md only means this directory is not a skill.
    }

    let entries: readonly string[];
    try {
        entries = [...(await fs.readdir(dir))].sort((a, b) => a.localeCompare(b));
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === SKILL_FILENAME) {
            continue;
        }

        const entryPath = join(dir, entry);
        let isDirectory = false;
        try {
            const stats =
                options.refuseSymbolicLinks === true
                    ? await fs.lstat(entryPath)
                    : await fs.stat(entryPath);
            if (stats.isSymbolicLink && options.refuseSymbolicLinks === true) {
                options.onInvalidSkill?.(entryPath);
                continue;
            }
            isDirectory = stats.isDirectory;
        } catch {
            continue;
        }

        if (isDirectory) {
            await collectSkillFilePaths(fs, entryPath, paths, options);
        }
    }
}
