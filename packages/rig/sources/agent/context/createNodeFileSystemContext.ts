import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    utimes,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { assertCanReadPath } from "./assertCanReadPath.js";
import { assertCanWritePath } from "./assertCanWritePath.js";
import { createUserSkillRootPaths } from "./createUserSkillRootPaths.js";
import type { FileSystemContext } from "./FileSystemContext.js";
import { toFileSystemStat } from "./toFileSystemStat.js";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "../../permissions/index.js";
import { getBuiltinSkillRoot } from "../skills/getBuiltinSkillRoot.js";

export interface CreateNodeFileSystemContextOptions {
    home?: string;
    permissionMode?: () => PermissionMode;
    platform?: NodeJS.Platform;
}

export function createNodeFileSystemContext(
    cwd: string,
    options: CreateNodeFileSystemContextOptions = {},
): FileSystemContext {
    const permissionMode = options.permissionMode ?? (() => DEFAULT_PERMISSION_MODE);
    const resolvePath = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
    const home = options.home ?? homedir();
    const readPathOptions = {
        allowedPaths: [getBuiltinSkillRoot(), ...createUserSkillRootPaths(home)],
        homeDirectory: home,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
    };
    return {
        cwd,
        home,
        async chmod(path, mode) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode());
            await chmod(target, mode);
        },
        async exists(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            try {
                await lstat(target);
                return true;
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
                ) {
                    return false;
                }
                throw error;
            }
        },
        async lstat(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return toFileSystemStat(await lstat(target));
        },
        async mkdir(path, options) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode());
            await mkdir(target, { recursive: options?.recursive ?? false });
        },
        async move(source, destination) {
            const sourceTarget = resolvePath(source);
            const destinationTarget = resolvePath(destination);
            await assertCanWritePath(cwd, sourceTarget, permissionMode());
            await assertCanWritePath(cwd, destinationTarget, permissionMode());
            await rename(sourceTarget, destinationTarget);
        },
        async realpath(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return realpath(target);
        },
        async readFile(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return readFile(target, "utf8");
        },
        async readFileBuffer(path, readOptions) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return readOptions?.maxBytes === undefined
                ? readFile(target)
                : readFileBufferWithLimit(target, readOptions.maxBytes);
        },
        async readdir(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return readdir(target);
        },
        async rm(path, options) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode());
            await rm(target, {
                recursive: options?.recursive ?? false,
                force: options?.force ?? false,
            });
        },
        async setModificationTime(path, mtimeMs) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode());
            const time = new Date(mtimeMs);
            await utimes(target, time, time);
        },
        async stat(path) {
            const target = resolvePath(path);
            await assertCanReadPath(cwd, target, permissionMode(), readPathOptions);
            return toFileSystemStat(await stat(target));
        },
        async writeFile(path, content) {
            const target = resolvePath(path);
            await assertCanWritePath(cwd, target, permissionMode());
            await writeFile(target, content);
        },
    };
}

async function readFileBufferWithLimit(path: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new Error("The file read limit must be a non-negative safe integer.");
    }
    const file = await open(path, "r");
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        while (length <= maxBytes) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) return Buffer.concat(chunks, length);
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
        }
        throw new Error(`Could not read '${path}' because it exceeds ${String(maxBytes)} bytes.`);
    } finally {
        await file.close();
    }
}
