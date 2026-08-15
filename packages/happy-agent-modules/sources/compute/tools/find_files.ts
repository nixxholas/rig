import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import { globToRegExp } from "../impl/globToRegExp.js";
import { relativeComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";
import { walkComputeFiles } from "../impl/walkComputeFiles.js";

/** How many paths one answer carries when the model does not ask for fewer. */
const DEFAULT_LIMIT = 100;

/** The tool that finds files by name anywhere under a directory. */
export function findFilesTool(compute: Compute) {
    return defineAgentTool({
        name: "find_files",
        description: `Find files by name pattern on the machine you are working on.

- Patterns match the whole path relative to the directory searched: "**/*.ts" finds TypeScript files at any depth, "src/*.ts" only directly inside src.
- \`**\` crosses directories, \`*\` and \`?\` stay within one name, and \`{a,b}\` offers alternatives.
- Results are ordered by how recently the file changed, so the ones being worked on come first.
- Git's own directory is never searched, and symbolic links are not followed.`,
        parameters: Type.Object(
            {
                pattern: Type.String({ description: "The glob pattern to match paths against." }),
                path: Type.Optional(
                    Type.String({
                        description: "The directory to search. Defaults to the working directory.",
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        description: `How many paths to return. Defaults to ${String(DEFAULT_LIMIT)}.`,
                        minimum: 1,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            root: Type.String(),
            files: Type.Array(Type.String()),
            total_matches: Type.Integer(),
            truncated: Type.Boolean(),
        }),
        // Finding files changes nothing.
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "searching"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        execute: async (ctx, { pattern, path, limit }) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const root = resolveComputePath(path ?? ".", compute.cwd, compute.fs.home);
            const expression = globToRegExp(pattern);
            const walked = await walkComputeFiles(compute.fs, permissions, root);
            const matched = walked.files
                .filter((file) => expression.test(relativeComputePath(root, file.path)))
                .sort((left, right) => right.mtimeMs - left.mtimeMs);
            const shown = matched.slice(0, limit ?? DEFAULT_LIMIT);
            return {
                root,
                files: shown.map((file) => file.path),
                total_matches: matched.length,
                truncated: walked.truncated || matched.length > shown.length,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.files.length === 0
                        ? result.truncated
                            ? "No matching files, but the search stopped at its limit before covering the whole tree. Search a narrower directory."
                            : "No matching files."
                        : result.truncated
                          ? `${result.files.join("\n")}\n[Showing ${String(result.files.length)} of ${String(result.total_matches)} matches. Narrow the pattern or the directory to see the rest.]`
                          : result.files.join("\n"),
            },
        ],
    });
}
