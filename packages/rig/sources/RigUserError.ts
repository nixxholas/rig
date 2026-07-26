/**
 * A failure the person running Rig can act on, such as a missing session or an unknown flag.
 * These are reported as a short explanation with an optional next step, never as a stack trace.
 */
export class RigUserError extends Error {
    readonly hint: string | undefined;

    constructor(message: string, options: { cause?: unknown; hint?: string } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "RigUserError";
        this.hint = options.hint;
    }
}

export function isRigUserError(error: unknown): error is RigUserError {
    return error instanceof RigUserError;
}
