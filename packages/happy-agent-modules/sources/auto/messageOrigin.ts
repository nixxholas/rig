import type { AgentMessageMetadata } from "@slopus/happy-agent-base";

/**
 * The provenance marker that decides whether a user-role message may ever be trusted as human
 * authorization by the automatic permission reviewer.
 *
 * The reviewer's entire trust model rests on one distinction: a message the human actually typed
 * versus a message an agent, a tool, or the environment produced that merely wears the user role.
 * Provider input shapes only have "user" and "assistant" roles, so goal continuations, collaboration
 * hand-offs, and surfaced shell commands all arrive as `role: "user"`. If trust were inferred from
 * the *absence* of a marker, any of those synthetic messages — including one an agent writes for
 * itself, such as its own goal objective — would be read as the user authorizing an action. That is
 * a forgery path, so trust must require an explicit, positive statement of human origin and never be
 * inferred from missing metadata.
 *
 * The rule is therefore: a host stamps a genuine end-user submission with `messageOrigin: "user"`;
 * everything the system generates on the agent's behalf stamps `messageOrigin: "agent"` (or leaves
 * the field off, which is treated the same way). Only `"user"` is trusted; anything else, including
 * an unstamped message, is untrusted context. This fails closed: a human path that forgets the
 * marker under-authorizes rather than an agent path over-authorizing.
 */

/** The metadata key carrying a message's provenance for the automatic permission reviewer. */
export const MESSAGE_ORIGIN_METADATA_KEY = "messageOrigin";

/** Stamp a message the end user actually submitted; only this provenance may be trusted evidence. */
export const USER_MESSAGE_ORIGIN_METADATA = Object.freeze({
    [MESSAGE_ORIGIN_METADATA_KEY]: "user",
} as const);

/** Stamp a message the system generated on the agent's behalf; never trusted user authorization. */
export const AGENT_MESSAGE_ORIGIN_METADATA = Object.freeze({
    [MESSAGE_ORIGIN_METADATA_KEY]: "agent",
} as const);

/**
 * Whether this message's metadata positively marks it as an end-user submission. A missing marker,
 * an `"agent"` marker, or any other value is not human origin.
 */
export function isUserOriginMetadata(metadata: AgentMessageMetadata | undefined): boolean {
    return (
        (metadata as { readonly [MESSAGE_ORIGIN_METADATA_KEY]?: unknown } | undefined)?.[
            MESSAGE_ORIGIN_METADATA_KEY
        ] === "user"
    );
}
