import type { PermissionContext } from "./PermissionContext.js";

export function assertPermissionRevision(
    permissions: PermissionContext,
    expectedRevision: number,
): void {
    if (permissions.revision !== expectedRevision) {
        throw new Error("Permission mode changed before the command could start.");
    }
}
