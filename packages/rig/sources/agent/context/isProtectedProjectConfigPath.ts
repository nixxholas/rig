import { resolve } from "node:path";

export function isProtectedProjectConfigPath(cwd: string, targetPath: string): boolean {
    return resolve(targetPath) === resolve(cwd, "rig.toml");
}
