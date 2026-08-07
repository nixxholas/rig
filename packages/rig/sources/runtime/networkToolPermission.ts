import type { PermissionMode } from "../permissions/index.js";

/**
 * The one rule every way of searching is measured against.
 *
 * Rig's search and fetch tools reach the network outside its sandbox, so they use one rule.
 */
export function permissionModeAllowsWebSearch(mode: PermissionMode | undefined): boolean {
    return mode === "auto" || mode === "full_access";
}

/**
 * The rule above, in the fields a tool definition declares.
 *
 * Spread into every tool Rig executes that reaches the open network — searching and fetching alike.
 * What they have in common is not that they search; it is where they end up, which is outside
 * everything Rig sandboxes. Written once so a third such tool cannot quietly answer differently.
 */
export const networkToolPermission = {
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
} as const;
