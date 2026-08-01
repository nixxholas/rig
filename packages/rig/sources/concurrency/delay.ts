import { AbortedError, throwIfAborted } from "./AbortedError.js";

/**
 * Waits for the given time, and for the abort signal when one is supplied.
 *
 * Without a signal this is an ordinary sleep. With one, the wait ends as soon
 * as the program starts shutting down, and that ending throws `AbortedError`
 * rather than returning quietly, so a caller cannot accidentally carry on as
 * though the full time had passed.
 */
// Declared async so an already-aborted signal rejects the returned promise
// rather than throwing synchronously at the call site.
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        function onAbort(): void {
            clearTimeout(timer);
            reject(new AbortedError());
        }

        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
