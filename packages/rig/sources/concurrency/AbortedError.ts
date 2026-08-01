/**
 * Thrown when work stops because its abort signal fired.
 *
 * This is a normal outcome rather than a failure: shutting down is the usual
 * reason to see it. Every primitive here throws it, and each caller either
 * handles it or lets it travel further up to whichever level actually cares.
 */
export class AbortedError extends Error {
    constructor(message = "The operation was aborted.") {
        super(message);
        this.name = "AbortedError";
    }
}

export function isAbortedError(error: unknown): error is AbortedError {
    return error instanceof AbortedError;
}

/** Throws if the signal has already fired, so work never starts after abort. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw new AbortedError();
}
