import type { DockerExecutionConfig } from "../../../execution/index.js";

/**
 * Why a terminal cannot be shown to another person, in one plain sentence.
 *
 * This is the whole security argument of the feature, so it is stated where it
 * is enforced rather than left in a design note:
 *
 * A shell on the owner's own machine can read `~/.claude`, `~/.codex`,
 * `~/.ssh`, `~/.aws`, the daemon's environment, and the managed proxy. Rig's
 * Read only mode deliberately still permits reading the host filesystem, so
 * there is no permission mode in this product that makes a host shell safe to
 * hand to somebody else. Mirroring is no safer than typing: the owner's own
 * `cat ~/.codex/auth.json` mirrors straight to the friend. The only version of
 * this feature that is honest is one confined to a container.
 */
export const PEER_TERMINAL_NEEDS_CONTAINER =
    "Sharing a terminal needs a container environment for this project. A terminal on your own machine can read your credentials, so Rig will not mirror one to anybody else.";

export interface PeerTerminalConfinement {
    readonly docker: DockerExecutionConfig;
    /** Directory a peer-visible terminal is pinned to, whatever it asked for. */
    readonly workingDirectory: string;
}

/**
 * Whether this project may offer `terminal_view` at all, and on what terms.
 *
 * Fails closed: without a configured Docker execution environment there is no
 * confinement to speak of, so the capability is not offerable and the reason
 * is readable English rather than a code.
 */
export function resolvePeerTerminalConfinement(
    docker: DockerExecutionConfig | undefined,
): { confinement: PeerTerminalConfinement } | { reason: string } {
    if (docker === undefined) return { reason: PEER_TERMINAL_NEEDS_CONTAINER };
    return {
        confinement: { docker, workingDirectory: docker.workingDirectory },
    };
}
