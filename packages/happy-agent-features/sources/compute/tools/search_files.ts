import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import { boundOutputText } from "../impl/boundOutputText.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import { globToRegExp } from "../impl/globToRegExp.js";
import { relativeComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";
import { walkComputeFiles } from "../impl/walkComputeFiles.js";

/** How many matching lines one answer carries when the model does not ask for fewer. */
const DEFAULT_LIMIT = 100;

/** How much of one matching line is worth showing; the rest is one long minified line. */
const MAX_LINE_CHARACTERS = 400;

/** How much text one answer may carry in total. */
const MAX_CHARACTERS = 40_000;

/** A file this large is data rather than source, and searching it costs more than it returns. */
const MAX_SEARCHED_FILE_CHARACTERS = 1_000_000;

/** The tool that searches file contents under a directory. */
export function searchFilesTool(compute: Compute) {
    return defineAgentTool({
        name: "search_files",
        description: `Search the contents of files on the machine you are working on.

- The pattern is a regular expression, matched line by line.
- Narrow the search with file_pattern, a glob over paths relative to the directory searched, such as "**/*.ts".
- Each match is reported as path:line: text, with long lines shortened.
- Git's own directory is never searched, symbolic links are not followed, and files that are not text are skipped.`,
        parameters: Type.Object(
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
                case_insensitive: Type.Optional(
                    Type.Boolean({ description: "Ignore case while matching. Defaults to false." }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        description: `How many matching lines to return. Defaults to ${String(DEFAULT_LIMIT)}.`,
                        minimum: 1,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            root: Type.String(),
            matches: Type.Array(Type.String()),
            matched_files: Type.Integer(),
            truncated: Type.Boolean(),
        }),
        // Searching changes nothing.
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "searching"),
        shouldReviewInAutoMode: ({ path }) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }),
        shouldRunInFullAccessInAutoMode: ({ path }) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }),
        execute: async (_ctx, { pattern, path, file_pattern, case_insensitive, limit }) => {
            const root = resolveComputePath(path ?? ".", compute.cwd, compute.fs.home);
            const expression = compileSearchPattern(pattern, case_insensitive === true);
            const fileExpression =
                file_pattern === undefined ? undefined : globToRegExp(file_pattern);
            const walked = await walkComputeFiles(compute.fs, root);
            const wanted = walked.files.filter(
                (file) =>
                    fileExpression === undefined ||
                    fileExpression.test(relativeComputePath(root, file.path)),
            );
            const matches: string[] = [];
            const matchedFiles = new Set<string>();
            let truncated = walked.truncated;
            for (const file of wanted) {
                if (matches.length >= (limit ?? DEFAULT_LIMIT)) {
                    truncated = true;
                    break;
                }
                let content: string;
                try {
                    content = await compute.fs.readFile(file.path);
                } catch {
                    // Something that cannot be read as text is not something to search.
                    continue;
                }
                // A null byte is what tells a file that is not text apart from one that is.
                if (content.length > MAX_SEARCHED_FILE_CHARACTERS || content.includes("\u0000")) {
                    continue;
                }
                for (const [index, line] of content.split(/\r?\n/).entries()) {
                    if (matches.length >= (limit ?? DEFAULT_LIMIT)) {
                        truncated = true;
                        break;
                    }
                    if (!expression.test(line)) continue;
                    matchedFiles.add(file.path);
                    matches.push(
                        `${file.path}:${String(index + 1)}: ${shortenLine(line.trimEnd())}`,
                    );
                }
            }
            return { root, matches, matched_files: matchedFiles.size, truncated };
        },
        toLLM: (result) => {
            if (result.matches.length === 0) return [{ type: "text", text: "No matches." }];
            const bounded = boundOutputText(result.matches.join("\n"), {
                maxCharacters: MAX_CHARACTERS,
            });
            return [
                {
                    type: "text",
                    text: result.truncated
                        ? `${bounded.text}\n[More matches exist than are shown. Narrow the pattern, the directory, or file_pattern.]`
                        : bounded.text,
                },
            ];
        },
    });
}

/** The model's pattern as an expression, or a failure it can act on. */
function compileSearchPattern(pattern: string, ignoreCase: boolean): RegExp {
    try {
        return new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (error) {
        throw new Error(
            `This is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** One matching line, cut where a line stops being readable. */
function shortenLine(line: string): string {
    return line.length <= MAX_LINE_CHARACTERS
        ? line
        : `${line.slice(0, MAX_LINE_CHARACTERS)}… (${String(line.length - MAX_LINE_CHARACTERS)} more characters)`;
}
