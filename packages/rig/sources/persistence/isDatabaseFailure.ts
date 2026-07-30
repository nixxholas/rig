export function isDatabaseFailure(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<Error>();
    while (pending.length > 0) {
        const current = pending.pop();
        if (!(current instanceof Error) || seen.has(current)) continue;
        seen.add(current);
        if (current.name === "DrizzleQueryError" || current.name === "SqliteError") return true;
        const code = (current as Error & { code?: unknown }).code;
        if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
        pending.push(current.cause);
        if (current instanceof AggregateError) pending.push(...current.errors);
    }
    return false;
}
