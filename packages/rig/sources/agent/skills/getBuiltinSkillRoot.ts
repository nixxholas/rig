import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read-only skills shipped inside Rig; this never points into a user's skill folders. */
export function getBuiltinSkillRoot(): string {
    const directory = dirname(fileURLToPath(import.meta.url));
    return basename(directory) === "dist"
        ? join(directory, "builtin-skills")
        : join(directory, "builtin");
}
