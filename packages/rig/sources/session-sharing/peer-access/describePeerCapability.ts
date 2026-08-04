import type { PeerActivityEntry, PeerCapability } from "./types.js";

/**
 * Short label for one capability, as a person would name it in a list.
 *
 * The switch is exhaustive rather than merely covering the one literal that
 * exists today: widening `PeerCapability` without adding a case here fails to
 * compile, so this can never fall through to a raw capability code a person
 * would have to decode.
 */
export function describePeerCapability(capability: PeerCapability): string {
    switch (capability) {
        case "terminal_view":
            return "Watch a terminal";
        default:
            capability satisfies never;
            throw new Error(
                `No English label is defined for peer capability "${String(capability)}".`,
            );
    }
}

/**
 * One sentence saying exactly what the capability lets the other person do.
 *
 * Exhaustive for the same reason as `describePeerCapability`: a capability
 * with nothing to say here is a promise the product cannot take back, not a
 * silently empty string.
 */
export function describePeerCapabilityDetail(capability: PeerCapability): string {
    switch (capability) {
        case "terminal_view":
            return "They can watch a container terminal in this session, including whatever is already on its screen and in its scrollback when you turn this on. They cannot type into it, resize it, or run anything.";
        default:
            capability satisfies never;
            throw new Error(
                `No detail sentence is defined for peer capability "${String(capability)}".`,
            );
    }
}

/** The list of capabilities a member holds, written for a person to read. */
export function describePeerCapabilities(capabilities: readonly PeerCapability[]): string {
    if (capabilities.length === 0) return "Read the conversation only";
    const labels = capabilities.map(describePeerCapability);
    if (labels.length === 1) return labels[0]!;
    return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!.toLowerCase()}`;
}

/**
 * What holding these capabilities lets a person do, as a phrase that reads
 * naturally right after "can" — "watch a terminal", not "Watch a terminal".
 *
 * This describes what is actually held, not what a project could merely
 * offer, so it stays a correct sentence even after an offer disappears out
 * from under a grant that predates it (the project loses its container, an
 * existing grant does not vanish with it). Grammatical for every input,
 * including holding nothing at all.
 */
export function describePeerCapabilitiesActivePhrase(
    capabilities: readonly PeerCapability[],
): string {
    if (capabilities.length === 0) return "do nothing beyond reading this session";
    const labels = capabilities.map((capability) => {
        const label = describePeerCapability(capability);
        return label.charAt(0).toLowerCase() + label.slice(1);
    });
    if (labels.length === 1) return labels[0]!;
    return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
}

/**
 * What granting a capability costs that no later action can undo.
 *
 * The owner sees this before they grant, not after. Revocation stops what
 * happens next and nothing else, and a terminal is exactly the place where a
 * secret crosses in a single line of scrollback.
 *
 * It says "already there" deliberately. A viewer's first frames are the
 * emulator's snapshot, and the protocol lets it ask for scrollback, so the
 * grant reaches backwards into output the owner produced before granting —
 * promising only "what happens from now on" would be a promise the code does
 * not keep.
 */
export function describePeerCapabilityGrantWarning(
    capabilities: readonly PeerCapability[],
): string {
    if (capabilities.length === 0) return "";
    const shared = [
        "Anything they see is theirs to keep, including what was already on that terminal when you turned this on. Turning it off stops what happens next; it cannot recall what has already been seen.",
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
