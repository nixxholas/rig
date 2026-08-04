import type { DockerExecutionConfig } from "../../execution/index.js";
import {
    describePeerCapability,
    describePeerCapabilityDetail,
    describePeerCapabilityGrantWarning,
} from "./describePeerCapability.js";
import {
    canProjectOfferPeerTerminals,
    PEER_TERMINAL_NEEDS_CONTAINER,
} from "./impl/peerTerminalConfinement.js";
import { PEER_CAPABILITIES, type PeerCapability } from "./types.js";

export interface OfferablePeerCapability {
    readonly capability: PeerCapability;
    readonly description: string;
    /** What granting this alone costs that no later action can undo, shown at grant time. */
    readonly grantWarning: string;
    readonly label: string;
    readonly offerable: boolean;
    readonly unavailableReason?: string;
}

/**
 * Which capabilities this session could offer at all, and why not when not.
 *
 * The owner is told before they try, not after they are refused, and always in
 * a sentence rather than a code. `terminal_view` is offerable only where the
 * project has a container environment to confine the terminal to; everywhere
 * else it is listed as unavailable with the reason spelled out, because an
 * option that silently disappears reads like a bug rather than a decision.
 */
export function resolveOfferablePeerCapabilities(
    docker: DockerExecutionConfig | undefined,
): readonly OfferablePeerCapability[] {
    return PEER_CAPABILITIES.map((capability) => {
        const base = {
            capability,
            description: describePeerCapabilityDetail(capability),
            grantWarning: describePeerCapabilityGrantWarning([capability]),
            label: describePeerCapability(capability),
        };
        // Whether the option is worth showing at all. A project answering yes here
        // grants nothing: the attach path re-asks the real terminal, which is the
        // check that actually confines anybody.
        return canProjectOfferPeerTerminals(docker)
            ? { ...base, offerable: true }
            : { ...base, offerable: false, unavailableReason: PEER_TERMINAL_NEEDS_CONTAINER };
    });
}
