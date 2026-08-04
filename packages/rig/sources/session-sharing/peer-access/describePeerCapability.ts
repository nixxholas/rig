import type { PeerActivityEntry, PeerCapability } from "./types.js";

/** Short label for one capability, as a person would name it in a list. */
export function describePeerCapability(capability: PeerCapability): string {
    if (capability === "terminal_view") return "Watch a terminal";
    return capability;
}

/** One sentence saying exactly what the capability lets the other person do. */
export function describePeerCapabilityDetail(capability: PeerCapability): string {
    if (capability === "terminal_view") {
        return "They can watch a container terminal in this session as you use it. They cannot type into it, resize it, or run anything.";
    }
    return "";
}

/** The list of capabilities a member holds, written for a person to read. */
export function describePeerCapabilities(capabilities: readonly PeerCapability[]): string {
    if (capabilities.length === 0) return "Read the conversation only";
    const labels = capabilities.map(describePeerCapability);
    if (labels.length === 1) return labels[0]!;
    return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!.toLowerCase()}`;
}

/**
 * What granting a capability costs that no later action can undo.
 *
 * The owner sees this before they grant, not after. Revocation stops what
 * happens next and nothing else, and a terminal is exactly the place where a
 * secret crosses in a single line of scrollback.
 */
export function describePeerCapabilityGrantWarning(
    capabilities: readonly PeerCapability[],
): string {
    if (capabilities.length === 0) return "";
    const shared = [
        "Anything they see while this is on is theirs to keep. Turning it off stops what happens next; it cannot recall what has already been seen.",
    ];
    if (capabilities.includes("terminal_view")) {
        shared.push(
            "Treat every credential that passes through a shared terminal as disclosed, and rotate it.",
        );
    }
    return shared.join(" ");
}

/**
 * One audit row as one sentence, for a reader rather than for a parser.
 *
 * The activity log is the only place the owner sees what somebody else actually
 * did, so it is written in the same English as everything else in the feature.
 * `who` is the member's display name when the caller knows it.
 */
export function describePeerActivityEntry(
    entry: Pick<PeerActivityEntry, "action" | "capability" | "detail" | "outcome">,
    who?: string,
): string {
    const name = who ?? "A member of this shared session";
    const verb = entry.action === "attach" ? "watch a terminal" : `${entry.action} a terminal`;
    const target = entry.detail === undefined ? "" : ` (${entry.detail})`;
    return entry.outcome === "allowed"
        ? `${name} started to ${verb}${target}.`
        : `${name} tried to ${verb}${target} and was refused.`;
}
