import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import type { FileReadLog } from "../impl/FileReadLog.js";
import { resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

/** The tool that removes one file after the agent has read it. */
export function deleteFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "delete_file",
        description: `Delete one file on the machine you are working on.

- Read the file with read_file first; this tool refuses a file this agent has not read.
- Directories are not removed by this tool. Use run_command when a recursive directory removal is genuinely needed.`,
        parameters: Type.Object(
            { path: Type.String({ description: "The file to delete." }) },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            deleted: Type.Boolean(),
        }),
        durable: false,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "deleting", { write: true }),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: true }, ctx),
        execute: async (ctx, { path }) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            const stat = await compute.fs.stat(permissions, filePath);
            if (stat.isDirectory) {
                throw new Error(
                    `This path is a directory; delete_file only removes files: ${filePath}`,
                );
            }
            await reads.assertRead(ctx, compute.fs, permissions, filePath);
            await compute.fs.rm(permissions, filePath, { force: false });
            return { path: filePath, deleted: true };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Deleted ${result.path}.`,
            },
        ],
    });
}
