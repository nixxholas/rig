import { minimumPermissionMode } from "../../permissions/minimumPermissionMode.js";
import type { PermissionMode } from "../../permissions/PermissionMode.js";
import type { PeerCapability } from "./types.js";

/**
 * The strongest mode each capability is ever allowed to run under.
 *
 * A friend is not the owner, so the owner's own authority is a limit rather
 * than a grant. Watching a terminal reads; nothing about it needs more than
 * Read only, and an owner sitting in Full access must not turn a viewer into
 * a full-access principal by being generous with themselves.
 */
const PEER_CAPABILITY_CEILING: Readonly<Record<PeerCapability, PermissionMode>> = {
    terminal_view: "read_only",
};

/**
 * The mode one peer action runs under, given the session's live mode.
 *
 * Both directions matter. The ceiling stops a permissive session from handing
 * a friend more than the capability is worth, and the session mode stops a
 * capability from surviving the owner reducing their own permissions. Because
 * this resolves at use time rather than at grant time, lowering the session
 * mode takes effect on the very next action.
 */
export function resolvePeerCapabilityCeiling(
    sessionMode: PermissionMode,
    capability: PeerCapability,
): PermissionMode {
    return minimumPermissionMode(sessionMode, PEER_CAPABILITY_CEILING[capability]);
}
