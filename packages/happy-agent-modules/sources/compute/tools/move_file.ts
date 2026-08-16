import { Type, type Static } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";

import type { Compute } from "../Compute.js";
import { canonicalComputePath } from "../impl/canonicalComputePath.js";
import { describeComputePathAction } from "../impl/describeComputePathAction.js";
import type { FileReadLog } from "../impl/FileReadLog.js";
import { parentComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

const moveFileParametersSchema = Type.Object(
    {
        source: Type.String({ description: "The file to move." }),
        destination: Type.String({ description: "The new path for the file." }),
    },
    { additionalProperties: false },
);

type MoveFileParameters = Static<typeof moveFileParametersSchema>;

/** The tool that renames or moves one file without overwriting another file. */
export function moveFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "move_file",
        description: `Move or rename one file on the machine you are working on.

- Read the source with read_file first; this tool refuses a source the agent has not read.
- The destination must not already exist. Missing parent directories are created.`,
        parameters: moveFileParametersSchema,
        returnType: Type.Object({
            source: Type.String(),
            destination: Type.String(),
        }),
        durable: false,
        describeAutoPermissionAction: ({ source, destination }) => {
            const sourceAction = describeComputePathAction(compute, source, "moving source", {
                write: true,
            });
            const destinationAction = describeComputePathAction(
                compute,
                destination,
                "creating destination",
                { write: true },
            );
            return `${sourceAction} Destination boundary: ${destinationAction}`;
        },
        shouldReviewInAutoMode: ({ source, destination }, ctx) =>
            reviewMovePaths(compute, source, destination, ctx),
        shouldRunInFullAccessInAutoMode: ({ source, destination }, ctx) =>
            reviewMovePaths(compute, source, destination, ctx),
        execute: async (ctx, { source, destination }: MoveFileParameters) => {
            const permissions = computePermissions(agentPermissionMode(ctx));
            const sourcePath = resolveComputePath(source, compute.cwd, compute.fs.home);
            const destinationPath = resolveComputePath(destination, compute.cwd, compute.fs.home);
            if (sourcePath === destinationPath) {
                throw new Error("The source and destination are the same path.");
            }
            const sourceStat = await compute.fs.stat(permissions, sourcePath);
            if (sourceStat.isDirectory) {
                throw new Error(
                    `This path is a directory; move_file only moves files: ${sourcePath}`,
                );
            }
            await reads.assertRead(ctx, compute.fs, permissions, sourcePath);
            const destinationExists = await compute.fs.exists(permissions, destinationPath);
            const existingDestinationStat = destinationExists
                ? await compute.fs.lstat(permissions, destinationPath)
                : undefined;
            const [canonicalSource, canonicalDestination] = await Promise.all([
                canonicalComputePath(compute.fs, permissions, sourcePath),
                canonicalComputePath(compute.fs, permissions, destinationPath),
            ]);
            const isCaseOnlyMove =
                existingDestinationStat?.isFile === true &&
                existingDestinationStat.isSymbolicLink === false &&
                canonicalSource === canonicalDestination &&
                sourcePath !== destinationPath;
            if (destinationExists && !isCaseOnlyMove) {
                throw new Error(`The move destination already exists: ${destinationPath}`);
            }
            const parent = parentComputePath(destinationPath);
            const createdDirectories =
                parent === destinationPath
                    ? []
                    : await missingParentDirectories(compute, permissions, parent);
            try {
                if (parent !== destinationPath) {
                    await compute.fs.mkdir(permissions, parent, { recursive: true });
                }
                await compute.fs.move(permissions, sourcePath, destinationPath);
            } catch (error) {
                await removeCreatedDirectories(compute, permissions, createdDirectories);
                throw error;
            }
            const movedDestinationStat = await compute.fs.stat(permissions, destinationPath);
            await reads.record(ctx, destinationPath, movedDestinationStat.mtimeMs);
            return { source: sourcePath, destination: destinationPath };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Moved ${result.source} to ${result.destination}.`,
            },
        ],
    });
}

async function missingParentDirectories(
    compute: Compute,
    permissions: Parameters<Compute["fs"]["exists"]>[0],
    directory: string,
): Promise<readonly string[]> {
    const missing: string[] = [];
    let current = directory;
    while (true) {
        if (await compute.fs.exists(permissions, current)) return missing;
        missing.push(current);
        const parent = parentComputePath(current);
        if (parent === current) return missing;
        current = parent;
    }
}

async function removeCreatedDirectories(
    compute: Compute,
    permissions: Parameters<Compute["fs"]["rm"]>[0],
    directories: readonly string[],
): Promise<void> {
    for (const directory of directories) {
        try {
            await compute.fs.rm(permissions, directory, {
                force: false,
                recursive: false,
            });
        } catch {
            // Cleanup is best effort and must not hide the move failure.
        }
    }
}

async function reviewMovePaths(
    compute: Compute,
    source: string,
    destination: string,
    ctx: Parameters<typeof shouldReviewComputePath>[3],
): Promise<boolean> {
    return (
        (await shouldReviewComputePath(compute, source, { write: true }, ctx)) ||
        (await shouldReviewComputePath(compute, destination, { write: true }, ctx))
    );
}
