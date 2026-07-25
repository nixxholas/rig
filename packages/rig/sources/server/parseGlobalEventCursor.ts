export function parseGlobalEventCursor(value: string | null): string | undefined {
    if (
        value === null ||
        value.length > 200 ||
        !/^[a-z0-9]+\.[a-z0-9]+$/iu.test(value)
    ) {
        return undefined;
    }
    return value;
}
