import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import {
    copyImportedTree,
    resolveImportedSourceReader,
    IMPORTED_SOURCE_MAX_BYTES,
    IMPORTED_SOURCE_MAX_FILES,
    IMPORTED_SOURCE_MAX_FILE_BYTES,
    type ImportedSourceReader,
    type ImportedTreeWriter,
} from "../imports/copyImportedTree.js";

import { AppletInvalidError } from "./AppletInvalidError.js";

export const APPLET_SOURCE_MAX_BYTES = IMPORTED_SOURCE_MAX_BYTES;
export const APPLET_SOURCE_MAX_FILES = IMPORTED_SOURCE_MAX_FILES;
export const APPLET_SOURCE_MAX_FILE_BYTES = IMPORTED_SOURCE_MAX_FILE_BYTES;

export type AppletSourceReader = ImportedSourceReader;

/** Uses the host filesystem for HTTP imports, or an agent/Docker filesystem when supplied. */
export function resolveAppletSourceReader(
    reader: FileSystemContext | AppletSourceReader | undefined,
): AppletSourceReader {
    return resolveImportedSourceReader(reader);
}

/**
 * Copies a static applet source tree into an already-created destination. Every source entry is
 * lstat'd and bounded before it is copied: symlinks, special files, oversized files, and source
 * trees large enough to harm the daemon are refused.
 */
export function copyAppletSource(
    sourcePath: string,
    destinationPath: string,
    sourceReader: AppletSourceReader,
    write: ImportedTreeWriter,
): Promise<void> {
    return copyImportedTree(sourcePath, destinationPath, sourceReader, write, {
        invalid: (message) => new AppletInvalidError(message),
        subject: "applet",
    });
}
