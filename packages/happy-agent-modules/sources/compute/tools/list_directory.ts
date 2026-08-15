import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

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
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path ?? ".", { write: false }, ctx),
        execute: async (ctx, { path }) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const directory = resolveComputePath(path ?? ".", compute.cwd, compute.fs.home);
            const stat = await compute.fs.stat(permissions, directory);
            if (!stat.isDirectory) {
                throw new Error(`This path is not a directory. Use read_file for it: ${directory}`);
            }
            const names = [...(await compute.fs.readdir(permissions, directory))].sort((left, right) =>
                left < right ? -1 : left > right ? 1 : 0,
            );
            const shown = names.slice(0, MAX_ENTRIES);
            const stats = await compute.fs.lstatMany(
                permissions,
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
