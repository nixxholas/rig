interface HappyIgnoreRule {
    readonly directoryOnly: boolean;
    readonly negated: boolean;
    readonly pattern: RegExp;
}

export interface HappyIgnore {
    ignores(path: string, directory: boolean): boolean;
}

/**
 * Compiles the Git-ignore syntax v1 delegated to `ignore`.
 *
 * The Happy Agent package intentionally has no runtime dependency on Rig's CLI package, so the
 * small matcher lives at this host boundary. It covers anchored and unanchored rules, all Git
 * globstar positions, escapes, character classes, directory-only matches, comments, trailing
 * spaces, and ordered negation.
 */
export function createHappyIgnore(contents: string): HappyIgnore {
    const rules = contents
        .split(/\r?\n/u)
        .map(parseRule)
        .filter((rule): rule is HappyIgnoreRule => rule !== undefined);
    return {
        ignores(path, directory) {
            let ignored = false;
            for (const rule of rules) {
                if (!rule.pattern.test(path)) continue;
                if (rule.directoryOnly && !directory && !matchesBelowDirectory(rule, path)) {
                    continue;
                }
                ignored = !rule.negated;
            }
            return ignored;
        },
    };
}

function parseRule(raw: string): HappyIgnoreRule | undefined {
    let source = stripTrailingSpaces(raw.replace(/^\uFEFF/u, ""));
    if (source.length === 0) return undefined;
    if (source.startsWith("#")) return undefined;

    let negated = false;
    if (source.startsWith("!")) {
        negated = true;
        source = source.slice(1);
    } else if (source.startsWith(String.raw`\!`) || source.startsWith(String.raw`\#`)) {
        source = source.slice(1);
    }
    if (source.length === 0) return undefined;

    const directoryOnly = endsWithUnescapedSlash(source);
    if (directoryOnly) source = source.slice(0, -1);
    const anchored = source.startsWith("/");
    if (anchored) source = source.slice(1);
    if (source.length === 0) return undefined;

    const containsSlash = source.includes("/");
    const expression = compileGlob(source);
    const prefix = anchored || containsSlash ? "^" : "(?:^|/)";
    return {
        directoryOnly,
        negated,
        pattern: new RegExp(`${prefix}${expression}(?:/.*)?$`, "u"),
    };
}

function compileGlob(source: string): string {
    let output = "";
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index]!;
        if (character === "\\") {
            const next = source[index + 1];
            if (next === undefined) {
                output += String.raw`\\`;
            } else {
                output += escapeRegExp(next);
                index += 1;
            }
            continue;
        }
        if (character === "[") {
            const characterClass = readCharacterClass(source, index);
            if (characterClass !== undefined) {
                output += characterClass.expression;
                index = characterClass.end;
                continue;
            }
            output += String.raw`\[`;
            continue;
        }
        if (character === "?") {
            output += "[^/]";
            continue;
        }
        if (character !== "*") {
            output += character === "/" ? "/" : escapeRegExp(character);
            continue;
        }

        let end = index;
        while (source[end + 1] === "*") end += 1;
        const globstar = end > index;
        if (!globstar) {
            output += "[^/]*";
            continue;
        }

        const previous = index === 0 ? undefined : source[index - 1];
        const next = source[end + 1];
        if (index === 0 && next === "/") {
            output += "(?:.*/)?";
            index = end + 1;
            continue;
        }
        if (previous === "/" && next === "/") {
            // The previous slash is already in the expression. Consume the following slash so
            // `foo/**/bar` also matches the zero-directory form `foo/bar`.
            output += "(?:[^/]+/)*";
            index = end + 1;
            continue;
        }
        if (previous === "/" && next === undefined) {
            output += ".*";
            index = end;
            continue;
        }
        output += "[^/]*";
        index = end;
    }
    return output;
}

function readCharacterClass(
    source: string,
    start: number,
): { end: number; expression: string } | undefined {
    let end = start + 1;
    let escaped = false;
    for (; end < source.length; end += 1) {
        const character = source[end]!;
        if (!escaped && character === "]" && end > start + 1) break;
        escaped = !escaped && character === "\\";
        if (character !== "\\") escaped = false;
    }
    if (end >= source.length) return undefined;
    let body = source.slice(start + 1, end);
    if (body.startsWith("!") || body.startsWith("^")) body = `^${body.slice(1)}`;
    body = body.replace(/\\/gu, String.raw`\\`);
    return { end, expression: `[${body}]` };
}

function stripTrailingSpaces(source: string): string {
    let end = source.length;
    while (end > 0 && source[end - 1] === " ") {
        let slashes = 0;
        for (let index = end - 2; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
        if (slashes % 2 === 1) {
            return `${source.slice(0, end - 2)} ${source.slice(end)}`;
        }
        end -= 1;
    }
    return source.slice(0, end);
}

function endsWithUnescapedSlash(source: string): boolean {
    if (!source.endsWith("/")) return false;
    let slashes = 0;
    for (let index = source.length - 2; index >= 0 && source[index] === "\\"; index -= 1) {
        slashes += 1;
    }
    return slashes % 2 === 0;
}

function matchesBelowDirectory(rule: HappyIgnoreRule, path: string): boolean {
    for (let index = path.lastIndexOf("/"); index >= 0; index = path.lastIndexOf("/", index - 1)) {
        if (rule.pattern.test(path.slice(0, index))) return true;
    }
    return false;
}

function escapeRegExp(character: string): string {
    return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
