/**
 * A capability request refused because this project cannot offer it, ever, not
 * because anything is temporarily wrong.
 *
 * Stable domain error consumed by the protocol HTTP adapter: a deliberate,
 * permanent refusal is a 4xx a client should not retry, never a 500.
 */
export class SessionShareCapabilityRefusalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionShareCapabilityRefusalError";
    }
}
