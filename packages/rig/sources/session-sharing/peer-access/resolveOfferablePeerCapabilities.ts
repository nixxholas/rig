import type { DockerExecutionConfig } from "../../execution/index.js";
import { describePeerCapability, describePeerCapabilityDetail } from "./describePeerCapability.js";
import { resolvePeerTerminalConfinement } from "./impl/peerTerminalConfinement.js";
import { PEER_CAPABILITIES, type PeerCapability } from "./types.js";

export interface OfferablePeerCapability {
    readonly capability: PeerCapability;
    readonly description: string;
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
            label: describePeerCapability(capability),
        };
        const confinement = resolvePeerTerminalConfinement(docker);
        return "reason" in confinement
            ? { ...base, offerable: false, unavailableReason: confinement.reason }
            : { ...base, offerable: true };
    });
}
