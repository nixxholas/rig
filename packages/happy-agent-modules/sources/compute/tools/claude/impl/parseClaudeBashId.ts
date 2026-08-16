/**
 * The command behind a Claude background shell identifier.
 *
 * Claude's shell tools name a running command with a string, while the machine numbers its
 * commands. The translation belongs to Claude's surface rather than to the machine, and anything
 * that is not one of those numbers is refused in a sentence the model can act on instead of being
 * coerced into command zero.
 */
export function parseClaudeBashId(bashId: string): number {
    const parsed = Number(bashId);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`This is not a background shell identifier: ${JSON.stringify(bashId)}`);
    }
    return parsed;
}
