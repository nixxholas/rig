/**
 * Recognizes a failure that came from the database, so callers can refuse to continue past it.
 *
 * Most driver faults arrive as `LibsqlError`, often with a `SQLITE_*` code. The driver reports
 * invalid bound values as a plain `Error` carrying no code, so that query failure is matched by its
 * exact message rather than by type. Treating every ordinary `Error` as a database failure would
 * turn programming mistakes into a daemon that refuses to run.
 */
const DRIVER_ERROR_MESSAGES = new Set([
    "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
]);

export function isDatabaseFailure(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<Error>();
    while (pending.length > 0) {
        const current = pending.pop();
        if (!(current instanceof Error) || seen.has(current)) continue;
        seen.add(current);
        if (current.name === "LibsqlError") return true;
        const code = (current as Error & { code?: unknown }).code;
        if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
        if (DRIVER_ERROR_MESSAGES.has(current.message)) return true;
        pending.push(current.cause);
        if (current instanceof AggregateError) pending.push(...current.errors);
    }
    return false;
}
