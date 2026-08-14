import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

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
        // Writing the same content twice leaves the same file, and the write records itself as a
        // read, so a call interrupted by a restart can simply be made again.
        durable: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "writing"),
        shouldReviewInAutoMode: ({ path }) =>
            shouldReviewComputePath(compute, path, { write: true }),
        shouldRunInFullAccessInAutoMode: ({ path }) =>
            shouldReviewComputePath(compute, path, { write: true }),
        execute: async (ctx, { path, content }) => {
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            await reads.assertRead(ctx, compute.fs, filePath);
            const existed = await compute.fs.exists(filePath);
            const parent = parentComputePath(filePath);
            if (parent !== filePath) await compute.fs.mkdir(parent, { recursive: true });
            await compute.fs.writeFile(filePath, content);
            // The agent now knows exactly what this file holds, so the next edit may proceed.
            await reads.record(ctx, filePath, (await compute.fs.stat(filePath)).mtimeMs);
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
