import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import type { FileReadLog } from "../impl/FileReadLog.js";
import { resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

/** The tool that replaces exact text inside a file the agent has read. */
export function editFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "edit_file",
        description: `Replace exact text in a file on the machine you are working on.

- Read the file with read_file first; this tool refuses a file this agent has not read.
- old_text must appear exactly once, unless replace_all is set. Include the surrounding lines needed to make it unique, and never include the line numbers read_file printed.
- Whitespace and indentation must match the file exactly.`,
        parameters: Type.Object(
            {
                path: Type.String({ description: "The file to change." }),
                old_text: Type.String({ description: "The exact text to replace." }),
                new_text: Type.String({ description: "The text to put in its place." }),
                replace_all: Type.Optional(
                    Type.Boolean({
                        description:
                            "Replace every occurrence instead of requiring exactly one. Defaults to false.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            replacements: Type.Integer(),
        }),
        // Deliberately not durable: repeating an edit that already landed would either fail to
        // find its own text or change something else that looks like it.
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "editing", { write: true }),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: true }, ctx),
        execute: async (ctx, { path, old_text, new_text, replace_all }) => {
            if (old_text === new_text) {
                throw new Error("The replacement is identical to the text it replaces.");
            }
            const permissions = computePermissions(agentPermissionMode(ctx));
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            await reads.assertRead(ctx, compute.fs, permissions, filePath);
            const content = await compute.fs.readFile(permissions, filePath);
            const occurrences = countOccurrences(content, old_text);
            if (occurrences === 0) {
                throw new Error(`This text does not appear in ${filePath}.`);
            }
            if (occurrences > 1 && replace_all !== true) {
                throw new Error(
                    `This text appears ${String(occurrences)} times in ${filePath}. Add surrounding context to make it unique, or set replace_all.`,
                );
            }
            const updated =
                replace_all === true
                    ? content.replaceAll(old_text, new_text)
                    : content.replace(old_text, new_text);
            await compute.fs.writeFile(permissions, filePath, updated);
            // The file on disk is now what this agent expects, so a following edit is not stale.
            await reads.record(ctx, filePath, (await compute.fs.stat(permissions, filePath)).mtimeMs);
            return { path: filePath, replacements: replace_all === true ? occurrences : 1 };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Changed ${result.path} (${String(result.replacements)} ${result.replacements === 1 ? "replacement" : "replacements"}).`,
            },
        ],
    });
}

/** How many times the text appears, counted without overlapping itself. */
function countOccurrences(content: string, text: string): number {
    if (text.length === 0) return 0;
    let count = 0;
    let index = content.indexOf(text);
    while (index >= 0) {
        count += 1;
        index = content.indexOf(text, index + text.length);
    }
    return count;
}
