export interface GitStatusEntry {
    /** Original path for a rename or copy. */
    from?: string;
    path: string;
    staged: boolean;
    unmerged: boolean;
    unstaged: boolean;
    untracked: boolean;
}

export interface GitStatusV2 {
    ahead: number;
    behind: number;
    branch?: string;
    detached: boolean;
    entries: readonly GitStatusEntry[];
    head?: string;
    upstream?: string;
}

/**
 * Parses `git status --porcelain=v2 -z --branch --untracked-files=all`.
 *
 * The `-z` form is the only status output that survives paths containing spaces, quotes, newlines,
 * or non-UTF-8 bytes: fields are NUL separated with no quoting or escaping, so this is a field
 * split rather than the unquoting guesswork that porcelain v1 requires.
 *
 * The one subtlety is that a rename or copy record (`2`) consumes a second NUL-terminated field for
 * its original path, so records cannot simply be zipped positionally.
 */
export function parseGitStatusV2(output: string): GitStatusV2 {
    const fields = output.split("\0");
    const entries: GitStatusEntry[] = [];
    let ahead = 0;
    let behind = 0;
    let branch: string | undefined;
    let head: string | undefined;
    let upstream: string | undefined;

    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field === undefined || field.length === 0) continue;
        const kind = field[0];

        if (kind === "#") {
            const [, name, ...rest] = field.split(" ");
            const value = rest.join(" ");
            if (name === "branch.oid") head = value === "(initial)" ? undefined : value;
            else if (name === "branch.head") branch = value === "(detached)" ? undefined : value;
            else if (name === "branch.upstream") upstream = value;
            else if (name === "branch.ab") {
                const [aheadValue, behindValue] = value.split(" ");
                ahead = parseSigned(aheadValue);
                behind = parseSigned(behindValue);
            }
            continue;
        }

        if (kind === "1" || kind === "2") {
            const parts = field.split(" ");
            const codes = parts[1] ?? "..";
            // Ordinary records end with the path; rename and copy records place the score before it
            // and carry the original path in the following NUL-terminated field.
            const path = parts.slice(kind === "1" ? 8 : 9).join(" ");
            const entry: GitStatusEntry = {
                path,
                staged: codes[0] !== "." && codes[0] !== undefined,
                unmerged: false,
                unstaged: codes[1] !== "." && codes[1] !== undefined,
                untracked: false,
            };
            if (kind === "2") {
                const from = fields[index + 1];
                index += 1;
                if (from !== undefined && from.length > 0) entry.from = from;
            }
            entries.push(entry);
            continue;
        }

        if (kind === "u") {
            entries.push({
                path: field.split(" ").slice(10).join(" "),
                staged: false,
                unmerged: true,
                unstaged: true,
                untracked: false,
            });
            continue;
        }

        if (kind === "?") {
            entries.push({
                path: field.slice(2),
                staged: false,
                unmerged: false,
                unstaged: true,
                untracked: true,
            });
        }
    }

    return {
        ahead,
        behind,
        ...(branch === undefined ? {} : { branch }),
        detached: head !== undefined && branch === undefined,
        entries,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}

function parseSigned(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}
