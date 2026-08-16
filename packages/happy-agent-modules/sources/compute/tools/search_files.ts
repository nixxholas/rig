import { Type, type Static } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import { boundOutputText } from "../impl/boundOutputText.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import { escapeRegExp } from "../impl/escapeRegExp.js";
import { globToRegExp } from "../impl/globToRegExp.js";
import { relativeComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";
import { walkComputeFiles } from "../impl/walkComputeFiles.js";

/** How many matching entries one answer carries when the model does not ask for fewer. */
const DEFAULT_LIMIT = 100;

/** How much of one matching line is worth showing; the rest is one long minified line. */
const MAX_LINE_CHARACTERS = 400;

/** How much text one answer may carry in total. */
const MAX_CHARACTERS = 40_000;

/** A file this large is data rather than source, and searching it costs more than it returns. */
const MAX_SEARCHED_FILE_CHARACTERS = 1_000_000;

/** Keep one pathological file from filling the search result before the output limit applies. */
const MAX_RETAINED_MATCHING_LINES_PER_FILE = 10_000;
const MAX_SEARCH_OFFSET = 100_000;
const MAX_SEARCH_LIMIT = 10_000;
const MAX_RETAINED_OUTPUT_ENTRIES = MAX_SEARCH_OFFSET + MAX_SEARCH_LIMIT + 1;
const MAX_REGEX_WORK = 4_000_000;
const MAX_REGEX_LINE_CHARACTERS = 4_096;

const searchOutputModeSchema = Type.Union([
    Type.Literal("content"),
    Type.Literal("files_with_matches"),
    Type.Literal("count"),
]);

const searchFilesParametersSchema = Type.Object(
    {
        pattern: Type.String({
            description: "The regular expression to look for in each line.",
        }),
        path: Type.Optional(
            Type.String({
                description: "The directory to search. Defaults to the working directory.",
            }),
        ),
        file_pattern: Type.Optional(
            Type.String({ description: "Search only files whose path matches this glob." }),
        ),
        type: Type.Optional(
            Type.String({
                description: "Optional file type such as ts, js, py, rust, go, or json.",
            }),
        ),
        output_mode: Type.Optional(
            Type.Union(
                [
                    Type.Literal("content"),
                    Type.Literal("files_with_matches"),
                    Type.Literal("count"),
                ],
                {
                    description:
                        'Output mode: "content" shows matching lines, "files_with_matches" shows paths, and "count" shows one match count per file. Defaults to "content".',
                },
            ),
        ),
        case_insensitive: Type.Optional(
            Type.Boolean({ description: "Ignore case while matching. Defaults to false." }),
        ),
        "-i": Type.Optional(Type.Boolean({ description: "Alias for case_insensitive." })),
        "-B": Type.Optional(
            Type.Integer({
                description: "Number of lines to show before each matching line.",
                minimum: 0,
            }),
        ),
        "-A": Type.Optional(
            Type.Integer({
                description: "Number of lines to show after each matching line.",
                minimum: 0,
            }),
        ),
        "-C": Type.Optional(
            Type.Integer({
                description: "Number of context lines to show before and after each match.",
                minimum: 0,
            }),
        ),
        context: Type.Optional(
            Type.Integer({
                description:
                    "Alias for -C: context lines before and after each match. -C wins when both are provided.",
                minimum: 0,
            }),
        ),
        "-n": Type.Optional(
            Type.Boolean({
                description: "Show line numbers in content output. Defaults to true.",
            }),
        ),
        limit: Type.Optional(
            Type.Integer({
                description: `How many output entries to return. Defaults to ${String(DEFAULT_LIMIT)}.`,
                minimum: 1,
                maximum: MAX_SEARCH_LIMIT,
            }),
        ),
        head_limit: Type.Optional(
            Type.Integer({
                description: "Alias for limit, matching Grep's head_limit.",
                minimum: 1,
                maximum: MAX_SEARCH_LIMIT,
            }),
        ),
        offset: Type.Optional(
            Type.Integer({
                description: "Skip this many output entries before applying the limit.",
                minimum: 0,
                maximum: MAX_SEARCH_OFFSET,
            }),
        ),
    },
    { additionalProperties: false },
);

const searchFilesResultSchema = Type.Object(
    {
        root: Type.String(),
        output_mode: searchOutputModeSchema,
        matches: Type.Array(Type.String()),
        matched_files: Type.Integer(),
        match_count: Type.Integer(),
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);

type SearchFilesParameters = Static<typeof searchFilesParametersSchema>;

interface FileMatches {
    readonly path: string;
    readonly lines: readonly string[];
    readonly matchingLineNumbers: readonly number[];
    readonly totalMatches: number;
    readonly matchingLinesTruncated: boolean;
}

interface SearchRegexBudget {
    remaining: number;
    incomplete: boolean;
    exhausted: boolean;
}

/** The common bounded search tool, with Git ignore and Grep-compatible output modes. */
export function searchFilesTool(compute: Compute) {
    return defineAgentTool({
        name: "search_files",
        description: `Search the contents of files on the machine you are working on.

- The pattern is a regular expression, matched line by line.
- Narrow the search with file_pattern or type. The supported Git-ignore subset skips matching files and directories, as do .git and symbolic links.
- output_mode content shows matching lines and optional -A/-B/-C context; files_with_matches shows paths; count shows match counts.
- offset skips output entries before limit. Results are bounded and say when more exists.`,
        parameters: searchFilesParametersSchema,
        returnType: searchFilesResultSchema,
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "searching"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        execute: async (ctx, args: SearchFilesParameters) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const root = resolveComputePath(args.path ?? ".", compute.cwd, compute.fs.home);
            const expression = compileSearchPattern(
                args.pattern,
                args.case_insensitive === true || args["-i"] === true,
            );
            const fileExpression =
                args.file_pattern === undefined ? undefined : globToRegExp(args.file_pattern);
            const walked = await walkComputeFiles(compute.fs, permissions, root, {
                respectGitIgnore: true,
            });
            const type = normalizeFileType(args.type);
            const wanted = walked.files.filter(
                (file) =>
                    (fileExpression === undefined ||
                        fileExpression.test(relativeComputePath(root, file.path))) &&
                    (type === undefined || type.test(file.path)),
            );
            const outputMode = args.output_mode ?? "content";
            const contextLines = args["-C"] ?? args.context ?? 0;
            const before = args["-B"] ?? contextLines;
            const after = args["-A"] ?? contextLines;
            const lineNumbers = args["-n"] !== false;
            const rawMatches: string[] = [];
            const regexBudget: SearchRegexBudget = {
                remaining: MAX_REGEX_WORK,
                incomplete: false,
                exhausted: false,
            };
            let matchedFiles = 0;
            let matchCount = 0;
            let outputTruncated = false;
            let contentFiles = 0;
            for (const file of wanted) {
                if (ctx.lifetime?.aborted === true) throw new Error("Search aborted.");
                if (file.size > MAX_SEARCHED_FILE_CHARACTERS) {
                    outputTruncated = true;
                    continue;
                }
                let content: string;
                try {
                    const bytes = await compute.fs.readFileBuffer(permissions, file.path, {
                        maxBytes: MAX_SEARCHED_FILE_CHARACTERS + 1,
                    });
                    if (bytes.byteLength > MAX_SEARCHED_FILE_CHARACTERS) {
                        outputTruncated = true;
                        continue;
                    }
                    content = new TextDecoder().decode(bytes);
                } catch {
                    outputTruncated = true;
                    continue;
                }
                if (content.length > MAX_SEARCHED_FILE_CHARACTERS || content.includes("\u0000")) {
                    continue;
                }
                const lines = content.split(/\r?\n/);
                if (lines.at(-1) === "") lines.pop();
                const matchingLineNumbers: number[] = [];
                let totalMatches = 0;
                for (const [index, line] of lines.entries()) {
                    const matched = testSearchPattern(expression, line, ctx, regexBudget);
                    if (!matched) {
                        if (regexBudget.exhausted) outputTruncated = true;
                        if (regexBudget.exhausted) break;
                        continue;
                    }
                    totalMatches += 1;
                    if (matchingLineNumbers.length < MAX_RETAINED_MATCHING_LINES_PER_FILE) {
                        matchingLineNumbers.push(index);
                    }
                }
                if (regexBudget.incomplete || regexBudget.exhausted) outputTruncated = true;
                if (totalMatches === 0) {
                    if (regexBudget.exhausted) break;
                    continue;
                }
                matchedFiles += 1;
                matchCount += totalMatches;
                const fileMatches: FileMatches = {
                    path: file.path,
                    lines,
                    matchingLineNumbers,
                    totalMatches,
                    matchingLinesTruncated: totalMatches > MAX_RETAINED_MATCHING_LINES_PER_FILE,
                };
                const entries =
                    outputMode === "files_with_matches"
                        ? [file.path]
                        : outputMode === "count"
                          ? [`${file.path}:${String(totalMatches)}`]
                          : contentOutput(fileMatches, before, after, lineNumbers);
                if (outputMode === "content" && contentFiles > 0) entries.unshift("--");
                if (outputMode === "content") contentFiles += 1;
                if (fileMatches.matchingLinesTruncated) outputTruncated = true;
                if (rawMatches.length >= MAX_RETAINED_OUTPUT_ENTRIES) {
                    outputTruncated = true;
                    continue;
                }
                const remaining = MAX_RETAINED_OUTPUT_ENTRIES - rawMatches.length;
                for (const entry of entries.slice(0, remaining)) rawMatches.push(entry);
                if (entries.length > remaining) outputTruncated = true;
                if (regexBudget.exhausted) break;
            }

            const offset = args.offset ?? 0;
            const limit = args.head_limit ?? args.limit ?? DEFAULT_LIMIT;
            const shown = rawMatches.slice(offset, offset + limit);
            const truncated =
                walked.truncated || outputTruncated || offset + shown.length < rawMatches.length;
            return {
                root,
                output_mode: outputMode,
                matches: shown,
                matched_files: matchedFiles,
                match_count: matchCount,
                truncated,
            };
        },
        toLLM: (result) => {
            if (result.matches.length === 0) {
                return [
                    {
                        type: "text",
                        text:
                            result.matched_files === 0
                                ? "No matches."
                                : "No matches in this page. Reduce offset or search a narrower scope.",
                    },
                ];
            }
            const bounded = boundOutputText(result.matches.join("\n"), {
                maxCharacters: MAX_CHARACTERS,
            });
            const notice =
                result.truncated || bounded.truncated
                    ? "\n[More matches exist than are shown. Narrow the pattern, the directory, or file_pattern, or use offset.]"
                    : "";
            return [{ type: "text", text: `${bounded.text}${notice}` }];
        },
    });
}

function contentOutput(
    file: FileMatches,
    before: number,
    after: number,
    lineNumbers: boolean,
): string[] {
    const output: string[] = [];
    const matching = new Set(file.matchingLineNumbers);
    const included = new Set<number>();
    for (const lineNumber of file.matchingLineNumbers) {
        const start = Math.max(0, lineNumber - before);
        const end = Math.min(file.lines.length - 1, lineNumber + after);
        for (let index = start; index <= end; index += 1) included.add(index);
    }
    const sorted = [...included].sort((left, right) => left - right);
    let previous = -1;
    for (const lineNumber of sorted) {
        if (previous >= 0 && lineNumber > previous + 1) output.push("--");
        const line = shortenLine(file.lines[lineNumber] ?? "");
        if (matching.has(lineNumber)) {
            output.push(
                lineNumbers
                    ? `${file.path}:${String(lineNumber + 1)}: ${line}`
                    : `${file.path}: ${line}`,
            );
        } else {
            output.push(
                lineNumbers
                    ? `${file.path}-${String(lineNumber + 1)}- ${line}`
                    : `${file.path}- ${line}`,
            );
        }
        previous = lineNumber;
    }
    return output;
}

/** The model's pattern as an expression, or a failure it can act on. */
function compileSearchPattern(pattern: string, ignoreCase: boolean): RegExp {
    if (/\([^()]*[+*{][^()]*\)[+*{]/.test(pattern)) {
        throw new Error(
            "This regular expression may backtrack excessively. Simplify nested repetitions before searching.",
        );
    }
    try {
        return new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (error) {
        throw new Error(
            `This is not a valid regular expression: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

function testSearchPattern(
    expression: RegExp,
    line: string,
    ctx: Context,
    budget: SearchRegexBudget,
): boolean {
    if (ctx.lifetime?.aborted === true) throw new Error("Search aborted.");
    if (budget.remaining <= 0) {
        budget.exhausted = true;
        return false;
    }
    const candidate = line.slice(0, MAX_REGEX_LINE_CHARACTERS);
    if (candidate.length < line.length) budget.incomplete = true;
    budget.remaining -= Math.max(1, candidate.length);
    const matched = expression.test(candidate);
    if (budget.remaining <= 0) budget.exhausted = true;
    return matched;
}

function normalizeFileType(type: string | undefined): RegExp | undefined {
    if (type === undefined) return undefined;
    const normalized = type.toLowerCase().replace(/^\./, "");
    if (normalized.length === 0) throw new Error("File type must not be empty.");
    const extensions: Readonly<Record<string, readonly string[]>> = {
        css: [".css"],
        go: [".go"],
        html: [".html", ".htm"],
        java: [".java"],
        js: [".js", ".jsx", ".mjs", ".cjs"],
        json: [".json"],
        md: [".md", ".markdown"],
        py: [".py"],
        rust: [".rs"],
        sh: [".sh", ".bash"],
        ts: [".ts", ".tsx", ".mts", ".cts"],
        yaml: [".yaml", ".yml"],
    };
    const candidates = extensions[normalized] ?? [`.${normalized}`];
    return new RegExp(`(?:${candidates.map(escapeRegExp).join("|")})$`, "i");
}

/** One matching line, cut where a line stops being readable. */
function shortenLine(line: string): string {
    return line.length <= MAX_LINE_CHARACTERS
        ? line
        : `${line.slice(0, MAX_LINE_CHARACTERS)}… (${String(line.length - MAX_LINE_CHARACTERS)} more characters)`;
}
