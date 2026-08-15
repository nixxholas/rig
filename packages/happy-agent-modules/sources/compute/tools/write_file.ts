import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import type { FileReadLog } from "../impl/FileReadLog.js";
import { parentComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

/** The tool that creates a file or replaces one whole. */
export function writeFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "write_file",
        description: `Write a file on the machine you are working on, creating it or replacing it entirely.

- Missing parent directories are created.
- An existing file must have been read with read_file first, and must not have changed since.
- Prefer edit_file for changing part of a file; this tool is for new files and complete rewrites.`,
        parameters: Type.Object(
            {
                path: Type.String({ description: "The file to write." }),
                content: Type.String({ description: "The complete contents of the file." }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            created: Type.Boolean(),
            characters: Type.Integer(),
        }),
        // The filesystem write cannot commit atomically with the tool result.
        durable: false,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "writing", { write: true }),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: true }, ctx),
        execute: async (ctx, { path, content }) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            await reads.assertRead(ctx, compute.fs, permissions, filePath);
            const existed = await compute.fs.exists(permissions, filePath);
            const parent = parentComputePath(filePath);
            if (parent !== filePath)
                await compute.fs.mkdir(permissions, parent, { recursive: true });
            await compute.fs.writeFile(permissions, filePath, content);
            // The agent now knows exactly what this file holds, so the next edit may proceed.
            await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
            return { path: filePath, created: !existed, characters: content.length };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.created ? "Created" : "Replaced"} ${result.path} (${String(result.characters)} characters).`,
            },
        ],
    });
}
