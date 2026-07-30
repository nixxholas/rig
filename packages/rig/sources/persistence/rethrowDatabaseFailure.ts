import { isDatabaseFailure } from "./isDatabaseFailure.js";

/**
 * Lets a database failure escape a handler that would otherwise absorb it.
 *
 * Passed to `.catch()` on work nobody awaits, it turns a database fault into an unhandled
 * rejection, which is the process-level hard failure the persistence plan requires. Every other
 * error stays absorbed, so recoverable cleanup keeps behaving as it did.
 */
export function rethrowDatabaseFailure(error: unknown): void {
    if (isDatabaseFailure(error)) throw error;
}
