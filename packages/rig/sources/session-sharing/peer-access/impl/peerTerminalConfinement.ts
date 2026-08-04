import type { RemoteTerminalConfinement } from "../../../terminal/RemoteTerminalProcess.js";

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

/**
 * Whether one terminal that already exists may be mirrored to another person.
 *
 * The question is asked of the terminal, never of the project. A project's
 * configuration can change under a terminal that is already running: configure
 * a container for a project that has host terminals open, and asking the
 * project would answer "container" about a process that is still a host shell.
 * The terminal records what actually started it, so this cannot drift.
 *
 * Fails closed: anything that is not positively a container is refused.
 */
export function isPeerTerminalConfined(confinement: RemoteTerminalConfinement): boolean {
    return confinement === "container";
}

/**
 * Why a terminal cannot be mirrored while anybody else is in the share.
 *
 * Murmur gives a shared session exactly one ephemeral channel, keyed from the
 * epoch that carries the transcript, and every member of the group decrypts
 * everything on it. There is no per-recipient addressing to reach for. Mirroring
 * to one member of a larger share would therefore also hand the terminal to
 * members who hold no capability at all, so the capability's own boundary would
 * not exist. Refusing is the only honest reading until the transport can address
 * a single member.
 */
export const PEER_TERMINAL_NEEDS_SOLE_MEMBER =
    "Sharing a terminal only works when one person is in the shared session. Everything on a shared session's live channel reaches everybody in it, so Rig will not mirror a terminal to a group.";

/**
 * Whether this project could offer terminal viewing at all, for the UI to say so.
 *
 * This one *is* a question about configuration, because it is asked before any
 * terminal exists — it decides whether to show the option. It is never the
 * check that lets a peer attach; that is `isPeerTerminalConfined`, against the
 * real terminal, and a project answering "yes" here grants nothing.
 */
export function canProjectOfferPeerTerminals(docker: unknown | undefined): boolean {
    return docker !== undefined;
}
