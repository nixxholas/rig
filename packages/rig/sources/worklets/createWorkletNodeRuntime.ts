import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface WorkletNodeRuntime {
    argv: readonly string[];
    executable: string;
}

/**
 * Runs a worklet through the same static jiti loader Pi uses for extensions.
 *
 * The bootstrap lives in the separate, sandboxed worklet process. It transforms TypeScript that
 * Node's erasable-types support cannot run (enums, parameter properties, and other syntax that
 * needs code generation), disables jiti's module cache, and maps the exact `happy-worklets`
 * specifier to the SDK this Rig ships.
 */
export async function createWorkletNodeRuntime(options: {
    entryPath: string;
}): Promise<WorkletNodeRuntime> {
    return {
        argv: [
            process.execPath,
            await resolveBootstrapPath(),
            options.entryPath,
            await resolveShippedSdkEntry(),
        ],
        executable: process.execPath,
    };
}

async function resolveBootstrapPath(): Promise<string> {
    const directory = dirname(fileURLToPath(import.meta.url));
    const shipped = join(directory, "worklet-bootstrap.js");
    try {
        await access(shipped);
        return shipped;
    } catch {
        return join(directory, "workletBootstrap.ts");
    }
}

async function resolveShippedSdkEntry(): Promise<string> {
    const shipped = join(dirname(fileURLToPath(import.meta.url)), "worklet-sdk");
    try {
        await access(join(shipped, "index.js"));
        return join(shipped, "index.js");
    } catch {
        return realpath(require.resolve("happy-worklets"));
    }
}
