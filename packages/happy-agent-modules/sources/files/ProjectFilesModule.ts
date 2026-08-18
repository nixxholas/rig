import { createHash, randomUUID } from "node:crypto";
import {
    mkdir,
    lstat,
    readdir,
    readFile,
    realpath,
    rename,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import type { GitModule } from "../git/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";

const MAX_FILE_BYTES = 44 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_TREE_ENTRIES = 500;
const MAX_WALK_ENTRIES = 20_000;

export const relativeFilePathSchema = Type.String({
    maxLength: 16_384,
    pattern: "^(?!/)(?!.*\\\\)(?!.*\\u0000)(?:[^/]+(?:/[^/]+)*)?$",
});
export const fileSearchQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
        query: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
);
export const fileTreeQuerySchema = Type.Object(
    {
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TREE_ENTRIES })),
        path: Type.Optional(relativeFilePathSchema),
    },
    { additionalProperties: false },
);
export const fileReadQuerySchema = Type.Object(
    { path: relativeFilePathSchema },
    { additionalProperties: false },
);
export const fileRevisionQuerySchema = Type.Object(
    {
        path: relativeFilePathSchema,
        revision: Type.String({
            minLength: 1,
            maxLength: 256,
            pattern: "^(?!-)[A-Za-z0-9_./:~^{}@-]+$",
        }),
    },
    { additionalProperties: false },
);
export const fileWriteSchema = Type.Object(
    {
        content: Type.String({ maxLength: MAX_FILE_BYTES * 2 }),
        expectedHash: Type.Union([
            Type.Null(),
            Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
        ]),
        path: relativeFilePathSchema,
    },
    { additionalProperties: false },
);
export const projectFileCurrentHashSchema = Type.Union([
    Type.Null(),
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
]);

export type FileSearchQuery = Static<typeof fileSearchQuerySchema>;
export type FileTreeQuery = Static<typeof fileTreeQuerySchema>;
export type FileReadQuery = Static<typeof fileReadQuerySchema>;
export type FileRevisionQuery = Static<typeof fileRevisionQuerySchema>;
export type FileWriteInput = Static<typeof fileWriteSchema>;
export type ProjectFileCurrentHash = Static<typeof projectFileCurrentHashSchema>;

export interface ProjectFileRoot {
    readonly projectId: string;
    readonly workspaceId?: string;
    readonly root: string;
}

export interface FileSearchResult {
    readonly files: readonly { readonly fileName: string; readonly path: string }[];
}

export interface FileTreeResult {
    readonly entries: readonly {
        readonly modified: number;
        readonly name: string;
        readonly path: string;
        readonly size: number;
        readonly type: "directory" | "file" | "other" | "symlink";
    }[];
    readonly nextCursor: string | null;
    readonly path: string;
}

export interface FileReadResult {
    readonly content: string;
    readonly hash: string;
}

export interface FileWriteResult {
    readonly hash: string;
}

export class ProjectFileError extends Error {
    readonly code: "conflict" | "forbidden" | "invalid" | "missing" | "too_large" | "unavailable";
    /** The file hash observed by the failed compare-and-swap, or null when it was absent. */
    readonly currentHash: ProjectFileCurrentHash;
    readonly status: 400 | 403 | 404 | 409 | 413 | 503;

    constructor(
        status: ProjectFileError["status"],
        code: ProjectFileError["code"],
        message: string,
        currentHash: ProjectFileCurrentHash = null,
    ) {
        super(message);
        if (!Value.Check(projectFileCurrentHashSchema, currentHash)) {
            throw new Error("The project file conflict hash is invalid.");
        }
        this.name = "ProjectFileError";
        this.code = code;
        this.currentHash = currentHash;
        this.status = status;
    }
}

export class ProjectFilesModule {
    readonly #git: GitModule;
    readonly #protectedPaths = [".git", "AGENTS.md", "AGENTS_SECURITY.md"] as const;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #writeLocks = new Map<string, Promise<void>>();

    constructor(projects: ProjectsModule, workspaces: WorkspacesModule, git: GitModule) {
        this.#git = git;
        this.#projects = projects;
        this.#workspaces = workspaces;
    }

    async resolveRoot(
        ctx: Context,
        projectId: string,
        workspaceId?: string,
    ): Promise<ProjectFileRoot> {
        const project = await this.#projects.get(ctx, projectId);
        if (project === undefined) {
            throw new ProjectFileError(404, "missing", "The project was not found.");
        }
        const projectRoot = await this.#canonicalRoot(project.repositoryRef);
        if (workspaceId === undefined) {
            return { projectId, root: projectRoot };
        }
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined || workspace.projectRef !== projectId) {
            throw new ProjectFileError(404, "missing", "The workspace was not found.");
        }
        if (workspace.status !== "ready") {
            throw new ProjectFileError(
                409,
                "conflict",
                "Only ready, available workspaces can access files.",
            );
        }
        // The workspace record says where it lives. A managed worktree sits in the agent's
        // workspaces directory, not inside the project, so deriving a path from the project would
        // name a folder that does not exist and hide the one that does.
        try {
            return {
                projectId,
                workspaceId,
                root: await this.#canonicalRoot(workspace.path),
            };
        } catch (error) {
            if (error instanceof ProjectFileError && error.status === 403) throw error;
            throw new ProjectFileError(
                409,
                "conflict",
                "Only ready, available workspaces can access files.",
            );
        }
    }

    async search(root: ProjectFileRoot, query: FileSearchQuery): Promise<FileSearchResult> {
        assertSchema(fileSearchQuerySchema, query, "file search query");
        const output: { fileName: string; path: string }[] = [];
        const normalized = query.query.toLocaleLowerCase();
        await this.#walk(root.root, "", async (path, information) => {
            if (output.length >= (query.limit ?? MAX_SEARCH_RESULTS)) return false;
            if (information.isFile()) {
                const fileName = path.split("/").at(-1) ?? path;
                if (path.toLocaleLowerCase().includes(normalized)) {
                    output.push({ fileName, path });
                }
            }
            return true;
        });
        return { files: output };
    }

    async listPaths(
        root: ProjectFileRoot,
    ): Promise<{ readonly paths: readonly string[]; readonly truncated: boolean }> {
        const paths: string[] = [];
        let truncated = false;
        await this.#walk(root.root, "", async (path, information) => {
            if (paths.length >= 20_000) {
                truncated = true;
                return false;
            }
            if (information.isFile()) paths.push(path);
            return true;
        });
        return { paths, truncated };
    }

    async tree(root: ProjectFileRoot, query: FileTreeQuery): Promise<FileTreeResult> {
        assertSchema(fileTreeQuerySchema, query, "file tree query");
        const path = query.path ?? "";
        const directory = await this.#resolveExisting(root.root, path, true);
        const information = await lstat(directory);
        if (!information.isDirectory()) {
            throw new ProjectFileError(400, "invalid", "The file-tree path must be a directory.");
        }
        const entries = await readdir(directory, { withFileTypes: true });
        const offset = parseCursor(query.cursor);
        const limit = query.limit ?? 100;
        const selected = entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(offset, offset + limit);
        const result = [];
        for (const entry of selected) {
            const relativePath = path === "" ? entry.name : `${path}/${entry.name}`;
            const entryPath = join(directory, entry.name);
            const entryInformation = await lstat(entryPath);
            result.push({
                modified: Math.trunc(entryInformation.mtimeMs),
                name: entry.name,
                path: relativePath,
                size: entryInformation.isFile() ? entryInformation.size : 0,
                type: entry.isDirectory()
                    ? ("directory" as const)
                    : entry.isFile()
                      ? ("file" as const)
                      : entry.isSymbolicLink()
                        ? ("symlink" as const)
                        : ("other" as const),
            });
        }
        return {
            entries: result,
            nextCursor:
                offset + selected.length < entries.length ? String(offset + selected.length) : null,
            path,
        };
    }

    async read(root: ProjectFileRoot, query: FileReadQuery): Promise<FileReadResult> {
        assertSchema(fileReadQuerySchema, query, "file read query");
        if (query.path.length === 0) {
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        }
        const path = await this.#resolveExisting(root.root, query.path, false);
        await this.#assertSafe(path, root.root, query.path);
        const bytes = await readFile(path);
        this.#assertSize(bytes.byteLength);
        return {
            content: bytes.toString("base64"),
            hash: sha256(bytes),
        };
    }

    async readRevision(
        root: ProjectFileRoot,
        query: FileRevisionQuery,
    ): Promise<{ readonly content: string | null; readonly hash: string | null }> {
        assertSchema(fileRevisionQuerySchema, query, "file revision query");
        if (query.path.length === 0) {
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        }
        await this.#assertSafeRelative(query.path);
        // Git answering with nothing — an unknown revision, a path that was not a file there, or
        // content past the bound — is "this file has no content at that revision", which is what a
        // client asking to see an older version needs to be told.
        const file = await this.#git
            .readFileAtRevision({
                maximumBytes: MAX_FILE_BYTES,
                path: root.root,
                relativePath: query.path,
                revision: query.revision,
            })
            .catch(() => ({ found: false }) as const);
        if (!file.found) return { content: null, hash: null };
        const bytes = Buffer.from(file.content);
        this.#assertSize(bytes.byteLength);
        return { content: bytes.toString("base64"), hash: sha256(bytes) };
    }

    async write(root: ProjectFileRoot, input: FileWriteInput): Promise<FileWriteResult> {
        assertSchema(fileWriteSchema, input, "file write request");
        if (input.path.length === 0) {
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        }
        await this.#assertSafeRelative(input.path);
        const bytes = decodeBase64(input.content);
        this.#assertSize(bytes.byteLength);
        const target = await this.#resolveWritePath(root.root, input.path);
        await this.#assertSafe(target, root.root, input.path);
        return await this.#withWriteLock(
            target,
            async () => await this.#writeCompared(target, input, bytes),
        );
    }

    async #writeCompared(
        target: string,
        input: FileWriteInput,
        bytes: Buffer,
    ): Promise<FileWriteResult> {
        let current: Buffer | undefined;
        try {
            current = await readFile(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (input.expectedHash === null && current !== undefined) {
            throw new ProjectFileError(
                409,
                "conflict",
                "The file already exists.",
                sha256(current),
            );
        }
        if (input.expectedHash !== null) {
            const currentHash = current === undefined ? null : sha256(current);
            if (currentHash !== input.expectedHash) {
                throw new ProjectFileError(
                    409,
                    "conflict",
                    "The file changed before it was written.",
                    currentHash,
                );
            }
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            await rename(temporary, target);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
        return { hash: sha256(bytes) };
    }

    /**
     * Serializes in-process compare-and-swap writes to one canonical path.
     *
     * A lock disappears as soon as its owner releases it, so idle paths retain no state and a
     * burst cannot leave an unbounded chain behind.
     */
    async #withWriteLock<Result>(path: string, work: () => Promise<Result>): Promise<Result> {
        const previous = this.#writeLocks.get(path);
        let release: (() => void) | undefined;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#writeLocks.set(path, current);
        await previous;
        try {
            return await work();
        } finally {
            release?.();
            if (this.#writeLocks.get(path) === current) {
                this.#writeLocks.delete(path);
            }
        }
    }

    /**
     * Proves the recorded folder is still the folder, then hands back its canonical form.
     *
     * A recorded path that now resolves somewhere else is a replaced folder, not a moved one: if
     * a project root or a workspace checkout were swapped for a link, following it would serve
     * one tree's files under another tree's name. Refusing is the only answer that cannot be
     * wrong; the record is corrected by re-probing the project, not by reading through the link.
     */
    async #canonicalRoot(path: string): Promise<string> {
        let canonical: string;
        try {
            canonical = await realpath(path);
            const information = await stat(canonical);
            if (!information.isDirectory()) {
                throw new ProjectFileError(
                    403,
                    "forbidden",
                    "The selected root is not a directory.",
                );
            }
        } catch (error) {
            if (error instanceof ProjectFileError) throw error;
            throw new ProjectFileError(404, "missing", "The selected root does not exist.");
        }
        if (canonical !== resolve(path)) {
            throw new ProjectFileError(
                403,
                "forbidden",
                "The recorded folder now points somewhere else.",
            );
        }
        return canonical;
    }

    async #resolveExisting(root: string, path: string, directory: boolean): Promise<string> {
        await this.#assertSafeRelative(path);
        const candidate = resolve(root, path);
        if (!isWithin(root, candidate)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        let canonical: string;
        try {
            canonical = await realpath(candidate);
        } catch {
            throw new ProjectFileError(404, "missing", "The requested path was not found.");
        }
        await this.#assertSafe(canonical, root, path);
        const information = await lstat(canonical);
        if (directory && !information.isDirectory()) {
            throw new ProjectFileError(400, "invalid", "The requested path is not a directory.");
        }
        return canonical;
    }

    async #resolveWritePath(root: string, path: string): Promise<string> {
        const candidate = resolve(root, path);
        if (!isWithin(root, candidate)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        try {
            return await realpath(candidate);
        } catch {
            const parent = await realpath(dirname(candidate)).catch(() => undefined);
            if (parent === undefined) {
                throw new ProjectFileError(404, "missing", "The parent directory was not found.");
            }
            return join(parent, candidate.slice(dirname(candidate).length + 1));
        }
    }

    async #assertSafe(path: string, root: string, relativePath: string): Promise<void> {
        if (!isWithin(root, path)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        const segments = relativePath.split("/");
        if (
            segments.some((segment) =>
                this.#protectedPaths.some(
                    (protectedPath) =>
                        segment === protectedPath ||
                        relativePath === protectedPath ||
                        relativePath.startsWith(`${protectedPath}/`),
                ),
            )
        ) {
            throw new ProjectFileError(403, "forbidden", "The selected path is protected.");
        }
    }

    async #assertSafeRelative(path: string): Promise<void> {
        if (
            !Value.Check(relativeFilePathSchema, path) ||
            path.split("/").some((part) => part === ".." || part === ".")
        ) {
            throw new ProjectFileError(400, "invalid", "The path must be a relative POSIX path.");
        }
        if (
            this.#protectedPaths.some(
                (protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`),
            )
        ) {
            throw new ProjectFileError(403, "forbidden", "The selected path is protected.");
        }
    }

    async #walk(
        root: string,
        prefix: string,
        visit: (path: string, information: import("node:fs").Dirent) => Promise<boolean>,
        count = { value: 0 },
    ): Promise<void> {
        if (count.value >= MAX_WALK_ENTRIES) return;
        const directory = prefix === "" ? root : join(root, prefix);
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (entry.name === ".git") continue;
            const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            count.value++;
            if (!(await visit(path, entry))) return;
            if (entry.isDirectory()) await this.#walk(root, path, visit, count);
            if (count.value >= MAX_WALK_ENTRIES) return;
        }
    }

    #assertSize(bytes: number): void {
        if (bytes > MAX_FILE_BYTES) {
            throw new ProjectFileError(
                413,
                "too_large",
                "The project file exceeds the size limit.",
            );
        }
    }
}

function assertSchema<T extends import("@sinclair/typebox").TSchema>(
    schema: T,
    value: unknown,
    name: string,
): asserts value is Static<T> {
    if (!Value.Check(schema, value))
        throw new ProjectFileError(400, "invalid", `The ${name} is invalid.`);
}

function parseCursor(value: string | undefined): number {
    if (value === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new ProjectFileError(400, "invalid", "The file-tree cursor is invalid.");
    }
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor)) {
        throw new ProjectFileError(400, "invalid", "The file-tree cursor is invalid.");
    }
    return cursor;
}

function decodeBase64(value: string): Buffer {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new ProjectFileError(400, "invalid", "File content must be base64.");
    }
    return Buffer.from(value, "base64");
}

function isWithin(root: string, candidate: string): boolean {
    const rootPath = resolve(root);
    const candidatePath = resolve(candidate);
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}
