import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import { joinComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

/** How many names one listing may carry back. */
const MAX_ENTRIES = 1_000;

/** The tool that lists what one directory holds. */
export function listDirectoryTool(compute: Compute) {
    return defineAgentTool({
        name: "list_directory",
        description: `List the entries of one directory on the machine you are working on.

- Names are sorted, and a directory's name ends with a slash.
- This lists one level. Use find_files to look through a whole tree.`,
        parameters: Type.Object(
            {
                path: Type.Optional(
                    Type.String({
                        description: "The directory to list. Defaults to the working directory.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            entries: Type.Array(Type.String()),
            total_entries: Type.Integer(),
            truncated: Type.Boolean(),
        }),
        // Listing a directory again lists the directory again.
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path ?? ".", "listing"),
        shouldReviewInAutoMode: ({ path }) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }),
        shouldRunInFullAccessInAutoMode: ({ path }) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }),
        execute: async (_ctx, { path }) => {
            const directory = resolveComputePath(path ?? ".", compute.cwd, compute.fs.home);
            const stat = await compute.fs.stat(directory);
            if (!stat.isDirectory) {
                throw new Error(`This path is not a directory. Use read_file for it: ${directory}`);
            }
            const names = [...(await compute.fs.readdir(directory))].sort((left, right) =>
                left < right ? -1 : left > right ? 1 : 0,
            );
            const shown = names.slice(0, MAX_ENTRIES);
            const stats = await compute.fs.lstatMany(
                shown.map((name) => joinComputePath(directory, name)),
            );
            return {
                path: directory,
                entries: shown.map((name, index) =>
                    stats[index]?.isDirectory === true ? `${name}/` : name,
                ),
                total_entries: names.length,
                truncated: names.length > shown.length,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.entries.length === 0
                        ? "(empty directory)"
                        : result.truncated
                          ? `${result.entries.join("\n")}\n[Showing ${String(result.entries.length)} of ${String(result.total_entries)} entries.]`
                          : result.entries.join("\n"),
            },
        ],
    });
}
