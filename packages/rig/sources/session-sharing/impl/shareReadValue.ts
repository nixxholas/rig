/**
 * Defensive readers for the values a share projection is handed.
 *
 * The projection runs in persistence against JSON parsed straight out of the
 * database and cast to its expected type. A row written by an older Rig, a
 * partially populated event, or a shape nobody anticipated must produce a
 * smaller entry, never an unexpected passthrough — so every field a projector
 * copies is read through one of these rather than trusted.
 */
export function shareRecord(value: unknown): Record<string, unknown> | undefined {
    return value === null || typeof value !== "object" || Array.isArray(value)
        ? undefined
        : (value as Record<string, unknown>);
}

export function shareText(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * Reads free-form text written by a model or returned by a provider.
 *
 * A failure has to stay legible to a friend, so this text does replicate. But
 * nobody curated it, and a long one is usually long because it echoed something
 * back — a request body, a file, a command's output. Keeping it to the size of
 * an explanation keeps the explanation and leaves the echo behind.
 */
export function shareExplanation(value: unknown): string | undefined {
    const text = shareText(value);
    if (text === undefined) return undefined;
    return text.length <= MAX_EXPLANATION_LENGTH
        ? text
        : `${text.slice(0, MAX_EXPLANATION_LENGTH)}… The rest was too long to share.`;
}

const MAX_EXPLANATION_LENGTH = 600;

export function shareFlag(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

export function shareNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function shareInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function shareTextList(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const texts = value.filter((item) => typeof item === "string");
    return texts.length === value.length ? texts : undefined;
}

/** Copies the named fields that are present, skipping anything of another type. */
export function sharePick<TValue>(
    source: Record<string, unknown>,
    fields: readonly string[],
    read: (value: unknown) => TValue | undefined,
): Record<string, TValue> {
    const picked: Record<string, TValue> = {};
    for (const field of fields) {
        const value = read(source[field]);
        if (value !== undefined) picked[field] = value;
    }
    return picked;
}
