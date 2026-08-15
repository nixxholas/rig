import { execFile, type ExecFileException } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { createRequire } from "node:module";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const require = createRequire(import.meta.url);
const binaryDescriptorSchema = Type.Object(
    { path: Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);
const executablePaths = new Map<"ffmpeg" | "ffprobe", Promise<string>>();

export interface MediaCommandOptions {
    arguments: readonly string[];
    executable: "ffmpeg" | "ffprobe";
    signal?: AbortSignal;
    timeoutMs: number;
}

export interface MediaCommandResult {
    exitCode: number;
    stderr: string;
    stdout: string;
    timedOut: boolean;
}

export async function runBundledMediaCommand(
    options: MediaCommandOptions,
): Promise<MediaCommandResult> {
    const executable = await resolveBundledMediaExecutable(options.executable);
    return new Promise((resolve) => {
        execFile(
            executable,
            [...options.arguments],
            {
                encoding: "utf8",
                maxBuffer: 128 * 1024,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                timeout: options.timeoutMs,
            },
            (error: ExecFileException | null, stdout, stderr) => {
                resolve({
                    exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                    stderr,
                    stdout,
                    timedOut: error?.killed === true,
                });
            },
        );
    });
}

function resolveBundledMediaExecutable(executable: "ffmpeg" | "ffprobe"): Promise<string> {
    const existing = executablePaths.get(executable);
    if (existing !== undefined) return existing;
    const pending = prepareBundledMediaExecutable(executable);
    executablePaths.set(executable, pending);
    return pending;
}

async function prepareBundledMediaExecutable(executable: "ffmpeg" | "ffprobe"): Promise<string> {
    const packageName =
        executable === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "@ffprobe-installer/ffprobe";
    const descriptor: unknown = require(packageName);
    if (!Value.Check(binaryDescriptorSchema, descriptor)) {
        throw new Error(`Rig's bundled ${executable} executable is unavailable.`);
    }
    try {
        await access(descriptor.path, constants.X_OK);
    } catch {
        await chmod(descriptor.path, 0o755);
        await access(descriptor.path, constants.X_OK);
    }
    return descriptor.path;
}
