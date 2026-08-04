import { PERMISSION_RANK } from "./isPermissionReduction.js";
import type { PermissionMode } from "./PermissionMode.js";

/**
 * The weaker of two permission modes, on the one ranking the product has.
 *
 * A ceiling is expressed as a mode, so applying it is the same question as
 * "which of these two grants less". Sharing this with `isPermissionReduction`
 * keeps one ordering: a second ranking that disagreed would silently make a
 * ceiling either useless or unreachable.
 */
export function minimumPermissionMode(left: PermissionMode, right: PermissionMode): PermissionMode {
    return PERMISSION_RANK[right] < PERMISSION_RANK[left] ? right : left;
}
