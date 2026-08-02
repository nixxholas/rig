import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES,
    HAPPY_COMPUTE_MAX_FILE_BYTES,
    HappyComputeProviderError,
    type HappyComputeProviderHandlers,
} from "happy-plugins";

const missingFileSystemPathSchema = Type.Object({
    code: Type.Union([Type.Literal("ENOENT"), Type.Literal("ENOTDIR")]),
});

type LocalBashInstance = {
    root: string;
    workspace: string;
};

export type LocalBashComputeProvider = {
    close(): Promise<void>;
    handlers: HappyComputeProviderHandlers;
};

export function createLocalBashComputeProvider(
    instanceParent = requiredPluginDirectory(),
): LocalBashComputeProvider {
    const instances = new Map<string, LocalBashInstance>();
    let closed = false;
    const requireInstance = (instanceId: string) => {
        const instance = instances.get(instanceId);
        if (instance === undefined) {
            throw new HappyComputeProviderError(
                "instance_not_found",
                "The local Bash compute instance was not found.",
            );
        }
        return instance;
    };

    return {
        handlers: {
            async start({ workspaceSource: source }) {
                if (closed) {
                    throw new HappyComputeProviderError(
                        "provider_unhealthy",
                        "The local Bash compute provider is stopping.",
                    );
                }
                if (source.type !== "local_directory") {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        "Local Bash compute requires a local directory source.",
                    );
                }
                let sourcePath: string;
                try {
                    sourcePath = await realpath(source.path);
                } catch {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        "The local Bash compute source directory is unavailable.",
                    );
                }
                if (!(await lstat(sourcePath)).isDirectory()) {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        "The local Bash compute source must be a directory.",
                    );
                }
                await mkdir(instanceParent, { recursive: true });
                const root = await mkdtemp(join(instanceParent, "local-bash-"));
                const workspace = join(root, "workspace");
                try {
                    await cp(sourcePath, workspace, {
                        errorOnExist: true,
                        force: false,
                        preserveTimestamps: true,
                        recursive: true,
                    });
                } catch (error) {
                    await rm(root, { force: true, recursive: true });
                    throw error;
                }
                const instanceId = randomUUID();
                instances.set(instanceId, { root, workspace });
                return instanceId;
            },
            async read({ instanceId, path }) {
                const instance = requireInstance(instanceId);
                let target: string;
                try {
                    target = await resolveReadablePath(instance.workspace, path);
                } catch (error) {
                    throwIfMissingLocalBashPath(error);
                    throw error;
                }
                let info;
                try {
                    info = await lstat(target);
                } catch (error) {
                    throwIfMissingLocalBashPath(error);
                    throw error;
                }
                if (!info.isFile()) {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        "The local Bash compute path is not a file.",
                    );
                }
                if (info.size > HAPPY_COMPUTE_MAX_FILE_BYTES) {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        `Compute file reads cannot exceed ${String(HAPPY_COMPUTE_MAX_FILE_BYTES)} bytes.`,
                    );
                }
                let bytes: Buffer;
                try {
                    bytes = await readFile(target);
                } catch (error) {
                    throwIfMissingLocalBashPath(error);
                    throw error;
                }
                if (bytes.byteLength > HAPPY_COMPUTE_MAX_FILE_BYTES) {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        `Compute file reads cannot exceed ${String(HAPPY_COMPUTE_MAX_FILE_BYTES)} bytes.`,
                    );
                }
                return bytes;
            },
            async write({ bytes, instanceId, path }, context) {
                if (bytes.byteLength > HAPPY_COMPUTE_MAX_FILE_BYTES) {
                    throw new HappyComputeProviderError(
                        "invalid_request",
                        `Compute file writes cannot exceed ${String(HAPPY_COMPUTE_MAX_FILE_BYTES)} bytes.`,
                    );
                }
                const instance = requireInstance(instanceId);
                let target: string;
                try {
                    target = await resolveWritablePath(instance.workspace, path);
                } catch (error) {
                    throw new HappyComputeProviderError("invalid_request", errorToMessage(error));
                }
                const temporary = join(
                    dirname(target),
                    `.${basename(target)}.happy-compute-${randomUUID()}.tmp`,
                );
                try {
                    await writeFile(temporary, bytes, { flag: "wx" });
                    context.signal.throwIfAborted();
                    await rename(temporary, target);
                } finally {
                    await rm(temporary, { force: true });
                }
            },
            exec({ command, instanceId, timeoutMs }, context) {
                return runBoundedBash(
                    requireInstance(instanceId).workspace,
                    command,
                    timeoutMs,
                    context.signal,
                );
            },
            async stop({ instanceId }) {
                const instance = instances.get(instanceId);
                if (instance === undefined) return;
                instances.delete(instanceId);
                await rm(instance.root, { force: true, recursive: true });
            },
        },
        async close() {
            if (closed) return;
            closed = true;
            const roots = [...instances.values()].map((instance) => instance.root);
            instances.clear();
            await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
        },
    };
}

async function resolveReadablePath(workspace: string, path: string): Promise<string> {
    const target = resolveRelativePath(workspace, path);
    const canonical = await realpath(target);
    assertInside(workspace, canonical);
    return canonical;
}

async function resolveWritablePath(workspace: string, path: string): Promise<string> {
    const target = resolveRelativePath(workspace, path);
    const relativeTarget = relative(workspace, target);
    const segments = relativeTarget.split("/");
    let current = workspace;
    for (const segment of segments.slice(0, -1)) {
        const next = join(current, segment);
        const info = await lstat(next).catch(() => undefined);
        if (info === undefined) {
            await mkdir(next);
        } else {
            if (!info.isDirectory() || info.isSymbolicLink()) {
                throw new Error("Compute file paths cannot cross symbolic links or files.");
            }
        }
        current = next;
    }
    const info = await lstat(target).catch(() => undefined);
    if (info !== undefined) {
        if (info.isSymbolicLink() || info.isDirectory()) {
            throw new Error("The compute file target must be an ordinary file.");
        }
    }
    return target;
}

function resolveRelativePath(workspace: string, path: string): string {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === "..")) {
        throw new HappyComputeProviderError(
            "invalid_request",
            "Compute file paths must stay inside the instance.",
        );
    }
    const target = resolve(workspace, path);
    assertInside(workspace, target);
    return target;
}

function assertInside(workspace: string, target: string): void {
    const fromWorkspace = relative(workspace, target);
    if (fromWorkspace === "" || fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
        throw new HappyComputeProviderError(
            "invalid_request",
            "Compute file paths must stay inside the instance.",
        );
    }
}

function throwIfMissingLocalBashPath(error: unknown): void {
    if (!Value.Check(missingFileSystemPathSchema, error)) return;
    throw new HappyComputeProviderError(
        "invalid_request",
        "The requested local Bash compute file is unavailable.",
    );
}

function runBoundedBash(
    cwd: string,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<{
    exitCode: number | null;
    stderr: string;
    stderrTruncated: boolean;
    stdout: string;
    stdoutTruncated: boolean;
    timedOut: boolean;
}> {
    return new Promise((resolveResult, reject) => {
        const child = spawn("/bin/bash", ["-lc", command], {
            cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        child.stdout?.on("data", (chunk: Buffer) => {
            const appended = appendBounded(stdout, stdoutBytes, chunk);
            stdoutBytes = appended.bytes;
            stdoutTruncated ||= appended.truncated;
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            const appended = appendBounded(stderr, stderrBytes, chunk);
            stderrBytes = appended.bytes;
            stderrTruncated ||= appended.truncated;
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            stopChild(child);
        }, timeoutMs);
        timeout.unref();
        const abort = () => stopChild(child);
        signal.addEventListener("abort", abort, { once: true });
        child.once("error", (error) => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            if (signal.aborted) {
                reject(new Error("The compute command was cancelled."));
                return;
            }
            resolveResult({
                exitCode: timedOut ? null : code,
                stderr: decodeBoundedUtf8(Buffer.concat(stderr, stderrBytes)),
                stderrTruncated,
                stdout: decodeBoundedUtf8(Buffer.concat(stdout, stdoutBytes)),
                stdoutTruncated,
                timedOut,
            });
        });
    });
}

function appendBounded(
    chunks: Buffer[],
    bytes: number,
    chunk: Buffer,
): { bytes: number; truncated: boolean } {
    const remaining = HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES - bytes;
    if (remaining <= 0) return { bytes, truncated: chunk.byteLength > 0 };
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    return {
        bytes: bytes + kept.byteLength,
        truncated: kept.byteLength < chunk.byteLength,
    };
}

function decodeBoundedUtf8(bytes: Buffer): string {
    let text = bytes.toString("utf8");
    while (Buffer.byteLength(text, "utf8") > HAPPY_COMPUTE_MAX_COMMAND_OUTPUT_BYTES) {
        text = text.slice(0, -1);
    }
    return text;
}

function stopChild(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

function requiredPluginDirectory(): string {
    const directory = process.env.HAPPY_PLUGIN_DIRECTORY;
    if (directory === undefined || directory.trim() === "") {
        throw new Error("Happy did not provide HAPPY_PLUGIN_DIRECTORY to this plugin.");
    }
    return directory;
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
