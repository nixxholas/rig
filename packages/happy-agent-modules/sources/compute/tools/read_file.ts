import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { boundOutputText } from "../impl/boundOutputText.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import type { FileReadLog } from "../impl/FileReadLog.js";
import { computeImageSchema, imageMediaTypeForPath, readImageForModel } from "../impl/readImage.js";
import { resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

/** How many lines one read returns when the model does not ask for fewer. */
const MAX_LINES = 2_000;

/** How much text one read may carry, however few lines that turns out to be. */
const MAX_CHARACTERS = 60_000;

/** The tool that reads a text file and remembers having read it. */
export function readFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "read_file",
        description: `Read a text or supported image file from the machine you are working on.

- Paths may be absolute or relative to the working directory.
- Lines are numbered in the output. The numbers are not part of the file: never include them in text you later pass to edit_file.
- Up to ${String(MAX_LINES)} lines are returned at a time. Use offset and limit to walk through a longer file.
- PNG, JPEG, GIF, WebP, and BMP files are returned as image content; use view_image when you only need visual inspection.
- Reading a file is what earns the right to change it: write_file and edit_file refuse a file this agent has not read.`,
        parameters: Type.Object(
            {
                path: Type.String({ description: "The file to read." }),
                offset: Type.Optional(
                    Type.Integer({
                        description: "The first line to return, counting from 1.",
                        minimum: 1,
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        description: `How many lines to return. Defaults to ${String(MAX_LINES)}.`,
                        minimum: 1,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            content: Type.String(),
            start_line: Type.Integer(),
            returned_lines: Type.Integer(),
            total_lines: Type.Integer(),
            truncated: Type.Boolean(),
            image: Type.Optional(computeImageSchema),
        }),
        // Reading the same file again reads the same file.
        durable: true,
        transactional: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "reading"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        execute: async (ctx, { path, offset, limit }) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            const stat = await compute.fs.stat(permissions, filePath);
            if (stat.isDirectory) {
                throw new Error(`This path is a directory. Use list_directory for it: ${filePath}`);
            }
            if (imageMediaTypeForPath(filePath) !== undefined) {
                const image = await readImageForModel(compute, reads, ctx, permissions, filePath);
                return {
                    path: filePath,
                    content: `[Image: ${image.mime_type}]`,
                    start_line: 0,
                    returned_lines: 0,
                    total_lines: 0,
                    truncated: false,
                    image,
                };
            }
            const raw = await compute.fs.readFile(permissions, filePath);
            const lines = raw.split(/\r?\n/);
            const startLine = offset ?? 1;
            const selected = lines.slice(startLine - 1, startLine - 1 + (limit ?? MAX_LINES));
            const numbered = selected
                .map((line, index) => `${String(startLine + index)}\t${line}`)
                .join("\n");
            const bounded = boundOutputText(numbered, { maxCharacters: MAX_CHARACTERS });
            const result = {
                path: filePath,
                content: bounded.text,
                start_line: startLine,
                returned_lines: selected.length,
                total_lines: lines.length,
                truncated: bounded.truncated || startLine - 1 + selected.length < lines.length,
            };
            await reads.record(ctx, filePath, stat.mtimeMs);
            return result;
        },
        toLLM: (result) => [
            ...(result.image === undefined
                ? [
                      {
                          type: "text" as const,
                          text:
                              result.returned_lines === 0
                                  ? result.total_lines > 1
                                      ? `(no lines there; the file has ${String(result.total_lines)} lines)`
                                      : "(empty file)"
                                  : result.truncated
                                    ? `${result.content}\n[Showing lines ${String(result.start_line)} to ${String(result.start_line + result.returned_lines - 1)} of ${String(result.total_lines)}. Read on with offset.]`
                                    : result.content,
                      },
                  ]
                : [
                      {
                          type: "text" as const,
                          text: `Image: ${result.path}. Line offset and limit are ignored for image files.`,
                      },
                      {
                          type: "image" as const,
                          data: result.image.data,
                          mimeType: result.image.mime_type,
                      },
                  ]),
        ],
    });
}
