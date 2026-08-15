import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import {
    copyImportedTree,
    resolveImportedSourceReader,
    type ImportedSourceReader,
    type ImportedTreeWriter,
} from "../imports/copyImportedTree.js";

import { WorkletInvalidError } from "./WorkletInvalidError.js";

export type WorkletSourceReader = ImportedSourceReader;

/** Uses the host filesystem for HTTP installs, or an agent/Docker filesystem when supplied. */
export function resolveWorkletSourceReader(
    reader: FileSystemContext | WorkletSourceReader | undefined,
): WorkletSourceReader {
    return resolveImportedSourceReader(reader);
}

/**
 * Copies a worklet's TypeScript source tree into an already-created version folder. Every entry is
 * lstat'd and bounded first: symlinks, special files, oversized files, and source trees large
 * enough to harm the daemon are refused.
 */
export function copyWorkletSource(
    sourcePath: string,
    destinationPath: string,
    sourceReader: WorkletSourceReader,
    write: ImportedTreeWriter,
): Promise<void> {
    return copyImportedTree(sourcePath, destinationPath, sourceReader, write, {
        invalid: (message) => new WorkletInvalidError(message),
        subject: "worklet",
    });
}
