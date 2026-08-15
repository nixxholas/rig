import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import type { WorkletSourceReader } from "./copyWorkletSource.js";
import { isValidWorkletName } from "./isValidWorkletName.js";
import { resolveWorkletPermissions } from "./resolveWorkletPermissions.js";
import {
    WORKLET_MANIFEST_FILE_NAME,
    WORKLET_MANIFEST_MAX_BYTES,
    workletManifestSchema,
    type WorkletManifest,
} from "./WorkletManifest.js";
import { WorkletInvalidError } from "./WorkletInvalidError.js";

/**
 * Reads the `worklet.json` at the root of a source folder.
 *
 * The read goes through the same reader the import itself uses, so a folder living in an agent's
 * container is described by the manifest that container holds rather than by whatever happens to
 * sit at the same path on the host.
 */
export async function readWorkletManifest(
    sourcePath: string,
    sourceReader: WorkletSourceReader,
    options: { environment?: NodeJS.ProcessEnv; homeDirectory?: string } = {},
): Promise<WorkletManifest> {
    const manifestPath = join(sourcePath, WORKLET_MANIFEST_FILE_NAME);
    let facts;
    try {
        facts = await sourceReader.lstat(manifestPath);
    } catch {
        throw new WorkletInvalidError(
            `A worklet needs a ${WORKLET_MANIFEST_FILE_NAME} at the root of its source folder, naming it and declaring what it may touch. ${JSON.stringify(sourcePath)} has none.`,
        );
    }
    if (!facts.isFile || facts.isSymbolicLink) {
        throw new WorkletInvalidError(
            `The worklet's ${WORKLET_MANIFEST_FILE_NAME} must be an ordinary file.`,
        );
    }
    const bytes = await sourceReader.readFileBuffer(manifestPath, {
        maxBytes: WORKLET_MANIFEST_MAX_BYTES,
        noFollow: true,
    });
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
        throw new WorkletInvalidError(
            `The worklet's ${WORKLET_MANIFEST_FILE_NAME} is not valid JSON.`,
        );
    }
    if (!Value.Check(workletManifestSchema, parsed)) {
        const first = Value.Errors(workletManifestSchema, parsed).First();
        const detail = first === undefined ? "" : ` ${first.path || "value"}: ${first.message}`;
        throw new WorkletInvalidError(
            `The worklet's ${WORKLET_MANIFEST_FILE_NAME} is invalid.${detail}`,
        );
    }
    if (!isValidWorkletName(parsed.name)) {
        throw new WorkletInvalidError(
            `A worklet name must be kebab-case, such as "github-watch". Got ${JSON.stringify(parsed.name)}.`,
        );
    }
    // Permissions Rig cannot enforce are refused here rather than at launch, so a person reviewing
    // the install sees the refusal instead of a worklet that installs and then never starts.
    resolveWorkletPermissions(parsed.permissions, options);
    return parsed;
}
