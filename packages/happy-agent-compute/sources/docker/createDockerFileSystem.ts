import { posix } from "node:path";

import type { ComputeFileStat, ComputeFileSystem } from "../ComputeFileSystem.js";
import { EMPTY_COMPUTE_HOST_POLICY, type ComputeHostPolicy } from "../ComputeHostPolicy.js";
import type { ComputePermissions } from "../ComputePermissions.js";
import { assertDockerReadPath } from "./impl/assertDockerReadPath.js";
import { assertDockerWritePath } from "./impl/assertDockerWritePath.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { formatDockerTouchTimestamp } from "./impl/formatDockerTouchTimestamp.js";
import { isDockerNotFoundError } from "./impl/isDockerNotFoundError.js";
import { parseDockerPathStat } from "./impl/parseDockerPathStat.js";
import { resolveDockerPath } from "./impl/resolveDockerPath.js";
import { resolveDockerPrivateDirectories } from "./impl/resolveDockerHostPolicy.js";
import { runDockerExec } from "./impl/runDockerExec.js";

const MAX_FILE_READ_BYTES = 32 * 1024 * 1024;
// Linux NAME_MAX is 255 bytes. One extra byte carries the terminating NUL.
const MAX_DOCKER_DIRECTORY_ENTRY_BYTES = 256;
const DOCKER_ARCHIVE_BLOCK_BYTES = 512;
const MAX_DOCKER_ARCHIVE_METADATA_BYTES = 1024 * 1024;

/**
 * A {@link ComputeFileSystem} whose every call runs inside one container.
 *
 * Reads resolve against the fixed working directory and may reach the whole container filesystem;
 * writes go through {@link assertDockerWritePath}, which enforces the shared permission boundary in
 * the container's own paths, resolving symlinks inside the container so one cannot escape the
 * workspace. Metadata is read with BusyBox-portable shell so the backend works against a minimal
 * image, and large listings are paged so a directory too big to return at once still can be walked.
 */
export function createDockerFileSystem(
    environment: DockerEnvironment,
    hostPolicy: ComputeHostPolicy = EMPTY_COMPUTE_HOST_POLICY,
): ComputeFileSystem {
    const cwd = environment.config.workingDirectory;
    let canonicalCwd: Promise<string> | undefined;
    const resolvePath = (target: string) => {
        if (target !== posix.resolve(cwd)) return resolveDockerPath(environment, target);
        canonicalCwd ??= resolveDockerPath(environment, target).catch((error: unknown) => {
            canonicalCwd = undefined;
            throw error;
        });
        return canonicalCwd;
    };
    let privateVariablePaths: Promise<readonly string[]> | undefined;
    const loadPrivateVariablePaths = () => {
        privateVariablePaths ??= resolveDockerPrivateDirectories(
            environment,
            hostPolicy.privatePathVariables === undefined
                ? {}
                : { privatePathVariables: hostPolicy.privatePathVariables },
        ).catch((error: unknown) => {
            privateVariablePaths = undefined;
            throw error;
        });
        return privateVariablePaths;
    };
    const assertRead = async (permissions: ComputePermissions, path: string) =>
        assertDockerReadPath(
            cwd,
            path,
            permissions,
            resolvePath,
            hostPolicy,
            await loadPrivateVariablePaths(),
        );
    const assertWrite = async (permissions: ComputePermissions, path: string) =>
        assertDockerWritePath(
            cwd,
            path,
            permissions,
            resolvePath,
            hostPolicy,
            await loadPrivateVariablePaths(),
        );
    return {
        cwd,
        async chmod(permissions, path, mode) {
            const target = await assertWrite(permissions, path);
            await successfulExec(environment, ["chmod", (mode & 0o7777).toString(8), target]);
        },
        async exists(permissions, path) {
            const target = await assertRead(permissions, path);
            const result = await runDockerExec(await environment.container(), [
                "/bin/sh",
                "-c",
                'test -e "$1" || test -L "$1"',
                "compute-exists",
                target,
            ]);
            return result.exitCode === 0;
        },
        async lstat(permissions, path) {
            const target = await assertRead(permissions, path);
            const result = await runDockerExec(await environment.container(), [
                "/bin/sh",
                "-c",
                'kind=other; if [ -L "$1" ]; then kind=symlink; elif [ -d "$1" ]; then kind=directory; elif [ -f "$1" ]; then kind=file; fi; printf "%s\\n" "$kind" && stat -c "%s" -- "$1" && stat -c "%Y" -- "$1" && stat -c "%a" -- "$1"',
                "compute-metadata",
                target,
            ]);
            if (result.exitCode !== 0) throw dockerCommandError("inspect", target, result.stderr);
            return parseDockerLstat(result.stdout, target);
        },
        async lstatMany(permissions, paths) {
            if (paths.length === 0) return [];
            const targets = await Promise.all(paths.map((path) => assertRead(permissions, path)));
            const result = await runDockerExec(
                await environment.container(),
                [
                    "/bin/sh",
                    "-c",
                    'set -e\nfor target do\nif [ ! -e "$target" ] && [ ! -L "$target" ]; then printf "missing\\n0\\n0\\n0\\n"; continue; fi\nkind=other\nif [ -L "$target" ]; then kind=symlink; elif [ -d "$target" ]; then kind=directory; elif [ -f "$target" ]; then kind=file; fi\nprintf "%s\\n" "$kind"\nstat -c "%s" -- "$target"\nstat -c "%Y" -- "$target"\nstat -c "%a" -- "$target"\ndone',
                    "compute-directory-metadata",
                    ...targets,
                ],
                { maxOutputBytes: targets.length * 128 },
            );
            if (result.exitCode !== 0) {
                throw dockerCommandError("inspect directory entries", cwd, result.stderr);
            }
            return parseDockerLstatMany(result.stdout, targets);
        },
        async mkdir(permissions, path, options) {
            const target = await assertWrite(permissions, path);
            await successfulExec(environment, [
                "mkdir",
                ...(options?.recursive === true ? ["-p"] : []),
                "--",
                target,
            ]);
        },
        async move(permissions, source, destination) {
            const sourceTarget = await assertWrite(permissions, source);
            const destinationTarget = await assertWrite(permissions, destination);
            await successfulExec(environment, ["mv", "--", sourceTarget, destinationTarget]);
        },
        async realpath(permissions, path) {
            const target = await assertRead(permissions, path);
            return resolveDockerPath(environment, target);
        },
        async readFile(permissions, path) {
            return Buffer.from(await this.readFileBuffer(permissions, path)).toString("utf8");
        },
        async readFileBuffer(permissions, path, options) {
            const target = await assertRead(permissions, path);
            const maxBytes = Math.min(
                options?.maxBytes ?? MAX_FILE_READ_BYTES,
                MAX_FILE_READ_BYTES,
            );
            if (options?.noFollow === true) {
                return readDockerFileWithoutFollowing(
                    await environment.container(),
                    target,
                    maxBytes,
                );
            }
            const details = await this.stat(permissions, path);
            if (details.size > maxBytes) throw fileReadLimitError(target, maxBytes);
            const result = await runDockerExec(
                await environment.container(),
                ["cat", "--", target],
                {
                    maxOutputBytes: maxBytes + 1,
                },
            );
            if (result.exitCode !== 0) throw dockerCommandError("read", target, result.stderr);
            if (result.stdout.length > maxBytes) throw fileReadLimitError(target, maxBytes);
            return result.stdout;
        },
        async readdir(permissions, path) {
            const target = await assertRead(permissions, path);
            const result = await runDockerExec(await environment.container(), [
                "/bin/sh",
                "-c",
                'for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do { test -e "$entry" || test -L "$entry"; } || continue; printf "%s\\0" "${entry##*/}"; done',
                "compute-directory",
                target,
            ]);
            if (result.exitCode !== 0) throw dockerCommandError("list", target, result.stderr);
            return result.stdout
                .toString("utf8")
                .split("\0")
                .filter((entry) => entry.length > 0);
        },
        async readdirPage(permissions, path, options) {
            const target = await assertRead(permissions, path);
            const capacity = options.limit + 1;
            const maxOutputBytes = capacity * MAX_DOCKER_DIRECTORY_ENTRY_BYTES;
            const result = await runDockerExec(
                await environment.container(),
                [
                    "/bin/sh",
                    "-c",
                    'set -e\nexport LC_ALL=C\ncd "$1"\nfind . -mindepth 1 -maxdepth 1 -exec /bin/sh -c \'after=$1; shift; for entry do name=${entry#./}; if [ "$name" \\> "$after" ]; then printf "%s\\\\0" "$name"; fi; done\' compute-directory-page "$2" {} + | sort -z | head -c "$3"',
                    "compute-directory-page",
                    target,
                    options.after ?? "",
                    String(maxOutputBytes),
                ],
                {
                    maxOutputBytes,
                },
            );
            if (result.exitCode !== 0) throw dockerCommandError("list", target, result.stderr);
            const lastTerminator = result.stdout.lastIndexOf(0);
            const completeOutput =
                lastTerminator < 0
                    ? Buffer.alloc(0)
                    : result.stdout.subarray(0, lastTerminator + 1);
            const entries = completeOutput
                .toString("utf8")
                .split("\0")
                .filter((entry) => entry.length > 0);
            const hasMore = entries.length > options.limit;
            return { entries: entries.slice(0, options.limit), hasMore };
        },
        async rm(permissions, path, options) {
            const target = await assertWrite(permissions, path);
            await successfulExec(environment, [
                "rm",
                ...(options?.recursive === true ? ["-r"] : []),
                ...(options?.force === true ? ["-f"] : []),
                "--",
                target,
            ]);
        },
        async setModificationTime(permissions, path, mtimeMs) {
            const target = await assertWrite(permissions, path);
            await successfulExec(environment, [
                "env",
                "TZ=UTC0",
                "touch",
                "-m",
                "-t",
                formatDockerTouchTimestamp(mtimeMs),
                "--",
                target,
            ]);
        },
        async stat(permissions, path) {
            const target = await assertRead(permissions, path);
            const container = await environment.container();
            try {
                const response = (await container.infoArchive({
                    path: target,
                })) as NodeJS.ReadableStream & {
                    destroy?: () => void;
                    headers?: Record<string, string | string[] | undefined>;
                };
                try {
                    return parseDockerPathStat(response.headers?.["x-docker-container-path-stat"]);
                } finally {
                    response.destroy?.();
                }
            } catch (error) {
                if (isDockerNotFoundError(error)) throw dockerCommandError("inspect", target);
                throw error;
            }
        },
        async writeFile(permissions, path, content) {
            const target = await assertWrite(permissions, path);
            const parent = posix.dirname(target);
            await successfulExec(environment, ["mkdir", "-p", "--", parent]);
            await successfulExec(
                environment,
                ["/bin/sh", "-c", 'cat > "$1"', "compute-write", target],
                { stdin: content },
            );
        },
    };
}

/**
 * Reads one regular file without dereferencing a symbolic link at its final component.
 *
 * Docker's archive endpoint returns the type and bytes from the same archived filesystem entry.
 * Rejecting link entries is therefore atomic with the read: there is no check syscall after which
 * another process can swap the final component before a later `cat` opens it.
 */
async function readDockerFileWithoutFollowing(
    container: Awaited<ReturnType<DockerEnvironment["container"]>>,
    path: string,
    maxBytes: number,
): Promise<Buffer> {
    const archive = await container.getArchive({ path });
    try {
        const bytes = await collectDockerFileArchive(archive, path, maxBytes);
        return extractDockerFileArchive(bytes, path, maxBytes);
    } finally {
        (
            archive as NodeJS.ReadableStream & {
                destroy?: () => void;
            }
        ).destroy?.();
    }
}

async function collectDockerFileArchive(
    archive: NodeJS.ReadableStream,
    path: string,
    maxBytes: number,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of archive) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.byteLength;
        if (length > maxBytes + MAX_DOCKER_ARCHIVE_METADATA_BYTES) {
            throw fileReadLimitError(path, maxBytes);
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
}

function extractDockerFileArchive(archive: Buffer, path: string, maxBytes: number): Buffer {
    let offset = 0;
    while (offset + DOCKER_ARCHIVE_BLOCK_BYTES <= archive.byteLength) {
        const header = archive.subarray(offset, offset + DOCKER_ARCHIVE_BLOCK_BYTES);
        if (header.every((byte) => byte === 0)) break;
        const size = parseDockerArchiveSize(header, path);
        const contentOffset = offset + DOCKER_ARCHIVE_BLOCK_BYTES;
        const paddedSize =
            Math.ceil(size / DOCKER_ARCHIVE_BLOCK_BYTES) * DOCKER_ARCHIVE_BLOCK_BYTES;
        const nextOffset = contentOffset + paddedSize;
        if (nextOffset > archive.byteLength) throw invalidDockerArchiveError(path);

        const type = header[156] ?? 0;
        if (type === 0 || type === 0x30) {
            if (size > maxBytes) throw fileReadLimitError(path, maxBytes);
            return Buffer.from(archive.subarray(contentOffset, contentOffset + size));
        }
        if (type === 0x31 || type === 0x32) {
            throw new Error(`Could not read '${path}' because it is a symbolic link.`);
        }
        // PAX and GNU long-name records describe the following entry rather than the path itself.
        if (![0x67, 0x78, 0x4b, 0x4c].includes(type)) {
            throw new Error(`Could not read '${path}' because it is not a regular file.`);
        }
        offset = nextOffset;
    }
    throw new Error(`Could not read '${path}' because it is not a regular file.`);
}

function parseDockerArchiveSize(header: Buffer, path: string): number {
    const raw = header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim();
    if (!/^[0-7]+$/.test(raw)) throw invalidDockerArchiveError(path);
    const size = Number.parseInt(raw, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw invalidDockerArchiveError(path);
    return size;
}

function invalidDockerArchiveError(path: string): Error {
    return new Error(`Docker returned an invalid archive while reading '${path}'.`);
}

function parseDockerLstat(output: Buffer, path: string): ComputeFileStat {
    const [kind, rawSize, rawMtime, rawMode, ...extra] = output
        .toString("utf8")
        .trimEnd()
        .split("\n");
    const size = Number(rawSize);
    const mtimeSeconds = Number(rawMtime);
    const mode = Number.parseInt(rawMode ?? "", 8);
    if (
        !["directory", "file", "other", "symlink"].includes(kind ?? "") ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isFinite(mtimeSeconds) ||
        !Number.isSafeInteger(mode) ||
        extra.length > 0
    ) {
        throw new Error(`Docker returned invalid link metadata for '${path}'.`);
    }
    return {
        isDirectory: kind === "directory",
        isFile: kind === "file",
        isSymbolicLink: kind === "symlink",
        mode,
        mtimeMs: mtimeSeconds * 1000,
        size,
    };
}

function parseDockerLstatMany(
    output: Buffer,
    paths: readonly string[],
): readonly (ComputeFileStat | undefined)[] {
    const lines = output.toString("utf8").trimEnd().split("\n");
    if (lines.length !== paths.length * 4) {
        throw new Error("Docker returned incomplete directory-entry metadata.");
    }
    return paths.map((path, index) => {
        const record = lines.slice(index * 4, index * 4 + 4);
        return record[0] === "missing"
            ? undefined
            : parseDockerLstat(Buffer.from(record.join("\n")), path);
    });
}

function fileReadLimitError(path: string, maxBytes: number): Error {
    return new Error(
        `Could not read '${path}' in the Docker container because it exceeds ${String(maxBytes)} bytes.`,
    );
}

async function successfulExec(
    environment: DockerEnvironment,
    command: readonly string[],
    options: { stdin?: string | Uint8Array } = {},
) {
    const result = await runDockerExec(await environment.container(), command, options);
    if (result.exitCode !== 0)
        throw dockerCommandError("access", command.at(-1) ?? "path", result.stderr);
}

function dockerCommandError(action: string, path: string, stderr?: Buffer): Error {
    const detail = stderr?.toString("utf8").trim();
    return new Error(
        detail === undefined || detail.length === 0
            ? `Could not ${action} '${path}' in the Docker container.`
            : `Could not ${action} '${path}' in the Docker container: ${detail}`,
    );
}
