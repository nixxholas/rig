import type { PermissionMode } from "../../permissions/index.js";

export function assertCanUseCommandSecrets(
    permissionMode: PermissionMode,
    secrets: readonly string[] | undefined,
): void {
    if (secrets !== undefined && secrets.length > 0 && permissionMode !== "full_access") {
        throw new Error(
            "Secrets require Full access. In Auto mode, select the secret on the shell command so Rig can review and elevate that exact command.",
        );
    }
}
