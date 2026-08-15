import { join } from "node:path";

import type { WorkletSourceReader } from "./copyWorkletSource.js";
import { WorkletInvalidError } from "./WorkletInvalidError.js";

/**
 * The two documents every worklet folder must carry, and who each one is for.
 *
 * A worklet is code that runs unattended for as long as it is installed, so the person who finds
 * it later is rarely the one who wrote it. `README.md` tells them what it does in plain language;
 * `DEVELOPMENT.md` tells whoever changes it next how it actually works inside.
 */
export const WORKLET_DOCUMENTS = [
    {
        audience: "explaining in plain language what the worklet does and why someone would run it",
        fileName: "README.md",
    },
    {
        audience: "explaining how the worklet works inside, for whoever changes it next",
        fileName: "DEVELOPMENT.md",
    },
] as const;

/** A document short enough to be a placeholder is not a document. */
const MINIMUM_DOCUMENT_BYTES = 32;

/** Prose is small; a file this size is something other than a document. */
const MAXIMUM_DOCUMENT_BYTES = 1024 * 1024;

/**
 * Refuses a source folder that does not carry both documents with something written in them.
 *
 * The check reads through the same reader the import uses, so a folder living in an agent's
 * container is judged by the files that container holds.
 */
export async function assertWorkletDocuments(
    sourcePath: string,
    sourceReader: WorkletSourceReader,
): Promise<void> {
    for (const { audience, fileName } of WORKLET_DOCUMENTS) {
        const path = join(sourcePath, fileName);
        let facts;
        try {
            facts = await sourceReader.lstat(path);
        } catch {
            throw new WorkletInvalidError(
                `A worklet needs a ${fileName} at the root of its source folder, ${audience}. ${JSON.stringify(sourcePath)} has none.`,
            );
        }
        if (!facts.isFile || facts.isSymbolicLink) {
            throw new WorkletInvalidError(`The worklet's ${fileName} must be an ordinary file.`);
        }
        if (facts.size > MAXIMUM_DOCUMENT_BYTES) {
            throw new WorkletInvalidError(
                `The worklet's ${fileName} is too large to be a document.`,
            );
        }
        const bytes = await sourceReader.readFileBuffer(path, {
            maxBytes: MAXIMUM_DOCUMENT_BYTES,
            noFollow: true,
        });
        if (Buffer.from(bytes).toString("utf8").trim().length < MINIMUM_DOCUMENT_BYTES) {
            throw new WorkletInvalidError(
                `The worklet's ${fileName} is empty or a placeholder. It should be worth reading, ${audience}.`,
            );
        }
    }
}
