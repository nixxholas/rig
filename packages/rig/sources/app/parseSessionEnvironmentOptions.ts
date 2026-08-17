export interface ParsedSessionEnvironmentOptions {
    debug?: boolean;
    remaining: readonly string[];
}

export function parseSessionEnvironmentOptions(
    args: readonly string[],
): ParsedSessionEnvironmentOptions {
    const remaining: string[] = [];
    let debug = false;

    for (const argument of args) {
        if (argument === "--debug") debug = true;
        else remaining.push(argument);
    }

    return { ...(debug ? { debug: true } : {}), remaining };
}