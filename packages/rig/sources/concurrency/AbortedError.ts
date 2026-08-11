import {
    AbortedError,
    isAbortedError,
    throwIfAborted as throwForContextLifetime,
    createRootContext,
    withLifetime,
} from "@steve.kite/stdlib";

export { AbortedError, isAbortedError };

/** Compatibility boundary for the remaining signal-shaped Rig callers. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
    throwForContextLifetime(
        signal === undefined ? createRootContext() : withLifetime(createRootContext(), signal),
    );
}
