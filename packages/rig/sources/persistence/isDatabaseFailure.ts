/**
 * Recognizes a failure that came from the database, so callers can refuse to continue past it.
 *
 * Most driver faults arrive as `SqliteError` with a `SQLITE_*` code, which is unambiguous. The
 * driver also reports a small set of query failures as a plain `TypeError` carrying no code at all.
 * They are matched by their exact messages rather than by type, because treating every `TypeError`
 * as a database failure would turn ordinary programming mistakes into a daemon that refuses to run.
 */
const DRIVER_TYPE_ERROR_MESSAGES = new Set([
    "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
    "The database connection is not open",
    "This database connection is busy executing a query",
    "This statement is busy executing a query",
]);

export function isDatabaseFailure(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<Error>();
    while (pending.length > 0) {
        const current = pending.pop();
        if (!(current instanceof Error) || seen.has(current)) continue;
        seen.add(current);
        if (current.name === "SqliteError") return true;
        const code = (current as Error & { code?: unknown }).code;
        if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
        if (current instanceof TypeError && DRIVER_TYPE_ERROR_MESSAGES.has(current.message)) {
            return true;
        }
        pending.push(current.cause);
        if (current instanceof AggregateError) pending.push(...current.errors);
    }
    return false;
}
