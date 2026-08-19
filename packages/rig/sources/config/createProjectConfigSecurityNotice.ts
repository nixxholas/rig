import type { PartialRigConfig } from "./types.js";

/**
 * The startup notice shown when a project's config file asked for a machine-level setting the
 * merge refused. Only the permission mode is machine-level in this file's schema; everything
 * else it may set is an ordinary preference.
 */
export function createProjectConfigSecurityNotice(
    config: PartialRigConfig,
    configFileName = "rig.toml",
): { text: string; title: string } | undefined {
    if (config.defaults?.permissionMode === undefined) return undefined;
    return {
        text: `This project's ${configFileName} requested a permission mode. Rig applied the other project preferences but kept your user-level permission choice.`,
        title: "Project permission ignored",
    };
}
