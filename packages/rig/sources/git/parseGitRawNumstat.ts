export type GitDiffChangeKind =
    | "added"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "submodule"
    | "type_changed";

export interface GitDiffChange {
    binary: boolean;
    deletions?: number;
    insertions?: number;
    kind: GitDiffChangeKind;
    path: string;
    previousPath?: string;
}

/**
 * Parses `git diff -z --raw --numstat --find-renames <base>`.
 *
 * One invocation produces both blocks from a single tree walk: the raw block gives the change
 * letters and unambiguous NUL-separated paths, and the numstat block gives the line counts. Running
 * two separate `diff` processes instead would be racy — an agent writing between them can produce
 * equal-length outputs describing different files, silently attaching one file's counts to another.
 *
 * Paths come from the raw block only. Numstat renders a rename as a single `old => new` string,
 * sometimes in the compressed `dir/{a => b}/file` form, so its paths are matched positionally
 * against the raw block rather than parsed.
 */
export function parseGitRawNumstat(output: string): readonly GitDiffChange[] {
    const fields = output.split("\0");
    const raw: { kind: GitDiffChangeKind; path: string; previousPath?: string }[] = [];
    let index = 0;

    // The raw block comes first and every one of its records starts with a colon.
    for (; index < fields.length; index += 1) {
        const field = fields[index];
        if (field === undefined || field.length === 0) continue;
        if (!field.startsWith(":")) break;
        const status = field.split(" ").at(-1) ?? "";
        const letter = status[0] ?? "M";
        const path = fields[index + 1] ?? "";
        index += 1;
        if (letter === "R" || letter === "C") {
            const destination = fields[index + 1] ?? "";
            index += 1;
            raw.push({
                kind: letter === "R" ? "renamed" : "copied",
                path: destination,
                previousPath: path,
            });
            continue;
        }
        raw.push({ kind: rawKind(letter, field), path });
    }

    // The numstat block follows, one `insertions\tdeletions\tpath` record per changed file in the
    // same order. Under `-z` a rename emits an empty path field followed by both paths.
    const counts: { binary: boolean; deletions: number; insertions: number }[] = [];
    for (; index < fields.length; index += 1) {
        const field = fields[index];
        if (field === undefined || field.length === 0) continue;
        const [insertions, deletions, inlinePath] = field.split("\t");
        if (deletions === undefined) continue;
        const binary = insertions === "-" || deletions === "-";
        counts.push({
            binary,
            deletions: binary ? 0 : parseCount(deletions),
            insertions: binary ? 0 : parseCount(insertions),
        });
        // An empty trailing path means the two rename paths follow as separate fields.
        if (inlinePath === undefined || inlinePath.length === 0) index += 2;
    }

    return raw.map((entry, position) => {
        const count = counts[position];
        const change: GitDiffChange = {
            binary: count?.binary ?? false,
            kind: entry.kind,
            path: entry.path,
            ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
        };
        // A submodule pointer change has no line counts to report, and a binary file has none to
        // report by definition.
        if (count !== undefined && !count.binary && entry.kind !== "submodule") {
            change.deletions = count.deletions;
            change.insertions = count.insertions;
        }
        return change;
    });
}

function rawKind(letter: string, record: string): GitDiffChangeKind {
    // Raw mode reports both modes; 160000 is a gitlink, so a changed submodule pointer is not a
    // file edit and must not be counted as one.
    const [, oldMode, newMode] = /^:(\d{6}) (\d{6})/u.exec(record) ?? [];
    if (oldMode === "160000" || newMode === "160000") return "submodule";
    if (letter === "A") return "added";
    if (letter === "D") return "deleted";
    if (letter === "T") return "type_changed";
    return "modified";
}

function parseCount(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
