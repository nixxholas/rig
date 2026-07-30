export function parseGlobalEventCursor(value: string | null): string | undefined {
    if (
        value === null ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
        return undefined;
    }
    return value.toLowerCase();
}
