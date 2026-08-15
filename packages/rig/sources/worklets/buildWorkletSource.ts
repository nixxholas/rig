import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "esbuild";

import { WorkletInvalidError } from "./WorkletInvalidError.js";

const ENTRY_FILE_NAMES = ["index.ts", "index.js", "index.mjs"] as const;
const BUILD_DIRECTORY_NAME = ".rig-build";
const BUILD_ENTRY_FILE_NAME = "index.mjs";
const MAXIMUM_BUILD_BYTES = 16 * 1024 * 1024;

/** Builds one immutable staged source tree before it can become the current version. */
export async function buildWorkletSource(sourceDirectory: string, name: string): Promise<void> {
    const entryPath = await resolveSourceEntry(sourceDirectory, name);
    let output;
    try {
        output = await build({
            absWorkingDir: sourceDirectory,
            bundle: true,
            entryPoints: [entryPath],
            external: ["happy-worklets"],
            format: "esm",
            legalComments: "none",
            logLevel: "silent",
            platform: "node",
            target: "node20",
            write: false,
        });
    } catch (error) {
        throw new WorkletInvalidError(
            `The worklet ${JSON.stringify(name)} could not be built: ${buildErrorMessage(error)}`,
        );
    }
    const built = output.outputFiles?.[0]?.contents;
    if (built === undefined || built.byteLength === 0) {
        throw new WorkletInvalidError(
            `The worklet ${JSON.stringify(name)} build produced no executable code.`,
        );
    }
    if (built.byteLength > MAXIMUM_BUILD_BYTES) {
        throw new WorkletInvalidError(
            `The worklet ${JSON.stringify(name)} build exceeds the 16 MiB limit.`,
        );
    }
    const buildDirectory = join(sourceDirectory, BUILD_DIRECTORY_NAME);
    await rm(buildDirectory, { force: true, recursive: true });
    await mkdir(buildDirectory);
    await writeFile(join(buildDirectory, BUILD_ENTRY_FILE_NAME), built);
}

export function builtWorkletEntry(versionDirectory: string): string {
    return join(versionDirectory, BUILD_DIRECTORY_NAME, BUILD_ENTRY_FILE_NAME);
}

async function resolveSourceEntry(sourceDirectory: string, name: string): Promise<string> {
    for (const fileName of ENTRY_FILE_NAMES) {
        const candidate = join(sourceDirectory, fileName);
        try {
            await access(candidate);
            return candidate;
        } catch {
            continue;
        }
    }
    throw new WorkletInvalidError(
        `The worklet ${JSON.stringify(name)} has no ${ENTRY_FILE_NAMES.join(", ")} at the root of its source folder.`,
    );
}

function buildErrorMessage(error: unknown): string {
    if (
        error instanceof Error &&
        "errors" in error &&
        Array.isArray(error.errors) &&
        typeof error.errors[0]?.text === "string"
    ) {
        return error.errors[0].text;
    }
    return error instanceof Error ? error.message : String(error);
}
