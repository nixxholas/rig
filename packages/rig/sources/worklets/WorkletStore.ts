import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { withDatabase } from "../persistence/databaseContext.js";
import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import { inTx } from "../persistence/inTx.js";
import { queryWorklet } from "../persistence/worklets/queryWorklet.js";
import { queryWorklets, type StoredWorklet } from "../persistence/worklets/queryWorklets.js";
import { workletAddVersion } from "../persistence/worklets/workletAddVersion.js";
import { workletCreate } from "../persistence/worklets/workletCreate.js";
import { workletDelete } from "../persistence/worklets/workletDelete.js";
import { workletSetCurrentVersion } from "../persistence/worklets/workletSetCurrentVersion.js";
import {
    installWorkletRequestSchema,
    revertWorkletRequestSchema,
    updateWorkletRequestSchema,
    type InstallWorkletRequest,
    type RevertWorkletRequest,
    type UpdateWorkletRequest,
    type WorkletPermissions,
} from "../protocol/WorkletProtocol.js";
import { getWorkletsDirectory } from "./getWorkletsDirectory.js";
import { assertWorkletDocuments } from "./assertWorkletDocuments.js";
import { readWorkletManifest } from "./readWorkletManifest.js";
import type { WorkletManifest } from "./WorkletManifest.js";
import {
    createWorkletIconArtifacts,
    WORKLET_ICON_MAX_BYTES,
    WorkletIconInvalidError,
    type WorkletIconArtifacts,
} from "./WorkletIcon.js";
import { WorkletInvalidError } from "./WorkletInvalidError.js";
import { WorkletNotFoundError } from "./WorkletNotFoundError.js";
import {
    copyWorkletSource,
    resolveWorkletSourceReader,
    type WorkletSourceReader,
} from "./copyWorkletSource.js";
import {
    readWorkletIcon,
    type WorkletIconFileResult,
    type WorkletIconFormat,
} from "./readWorkletIcon.js";
import { buildWorkletSource } from "./buildWorkletSource.js";

/** Folder entries inside a worklet's root that belong to Rig rather than to the worklet. */
const ICON_FILE_NAMES = ["favicon.png", "favicon.ico"] as const;
const DATA_FOLDER_NAME = "Data";
const IMPORT_STAGING_PREFIX = ".import-";

export interface WorkletStoreOptions {
    database: SessionDatabase;
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
}

export interface ExpectedWorkletDeclaration {
    name?: string;
    permissions?: WorkletPermissions;
}

/**
 * Owns the installed worklets: their catalog rows and the folders their code and data live in.
 *
 * A worklet is installed and updated by importing a source folder, exactly as an applet is: each
 * import lands in its own `v<n>` folder, one version is current, and reverting moves that pointer
 * without deleting anything. The `Data` folder beside those versions is never written by an
 * install, an update, a revert, or an uninstall — it is the durable half of a worklet.
 *
 * The store knows nothing about running processes. `WorkletManager` owns those.
 */
export class WorkletStore {
    readonly #database: SessionDatabase;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #now: () => number;
    readonly #mutationByName = new Map<string, Promise<void>>();

    constructor(options: WorkletStoreOptions) {
        this.#database = options.database;
        this.#environment = options.environment ?? process.env;
        this.#now = options.now ?? Date.now;
    }

    get directory(): string {
        return getWorkletsDirectory(this.#environment);
    }

    dataDirectory(name: string): string {
        return join(this.directory, name, DATA_FOLDER_NAME);
    }

    versionDirectory(name: string, version: number): string {
        return join(this.directory, name, `v${String(version)}`);
    }

    async get(ctx: Context, name: string): Promise<StoredWorklet | undefined> {
        ctx = withDatabase(ctx, this.#database);
        return queryWorklet(ctx, name);
    }

    async list(ctx: Context): Promise<readonly StoredWorklet[]> {
        ctx = withDatabase(ctx, this.#database);
        return queryWorklets(ctx);
    }

    /** Removes imports interrupted before they became a version. Called before management opens. */
    async cleanupStaging(_ctx: Context): Promise<void> {
        let entries: readonly string[];
        try {
            entries = await readdir(this.directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        await Promise.all(
            entries
                .filter((entry) => entry.startsWith(IMPORT_STAGING_PREFIX))
                .map((entry) => rm(join(this.directory, entry), { force: true, recursive: true })),
        );
    }

    /** The worklet names itself in its manifest, so the folder is read before anything is locked. */
    async install(
        ctx: Context,
        request: InstallWorkletRequest,
        sourceFileSystem?: FileSystemContext | WorkletSourceReader,
        expected: ExpectedWorkletDeclaration = {},
    ): Promise<StoredWorklet> {
        ctx = withDatabase(ctx, this.#database);
        if (!Value.Check(installWorkletRequestSchema, request)) {
            throw new WorkletInvalidError("The worklet install request is invalid.");
        }
        const sourceReader = resolveWorkletSourceReader(sourceFileSystem);
        const staging = await this.#stageSource(ctx, request.path, sourceReader);
        try {
            const icon = await this.#readIcon(ctx, request.iconPath, sourceReader);
            const stagedReader = resolveWorkletSourceReader(undefined);
            const manifest = await this.#readDeclaration(ctx, staging, stagedReader);
            this.#assertExpectedDeclaration(manifest, expected);
            await buildWorkletSource(staging, manifest.name);
            return await this.#serializeMutation(manifest.name, () =>
                this.#install(ctx, request, manifest, icon, staging),
            );
        } finally {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
        }
    }

    async update(
        ctx: Context,
        name: string,
        request: UpdateWorkletRequest,
        sourceFileSystem?: FileSystemContext | WorkletSourceReader,
        expected: ExpectedWorkletDeclaration = {},
    ): Promise<StoredWorklet> {
        ctx = withDatabase(ctx, this.#database);
        if (!Value.Check(updateWorkletRequestSchema, request)) {
            throw new WorkletInvalidError(
                "A worklet update needs the source folder path and a description of the change.",
            );
        }
        if ((await queryWorklet(ctx, name)) === undefined) {
            throw new WorkletNotFoundError(`No worklet named ${JSON.stringify(name)} exists.`);
        }
        const sourceReader = resolveWorkletSourceReader(sourceFileSystem);
        const staging = await this.#stageSource(ctx, request.path, sourceReader);
        try {
            const manifest = await this.#readDeclaration(
                ctx,
                staging,
                resolveWorkletSourceReader(undefined),
            );
            this.#assertExpectedDeclaration(manifest, { ...expected, name });
            await buildWorkletSource(staging, manifest.name);
            return await this.#serializeMutation(name, () =>
                this.#update(ctx, name, request, manifest, staging),
            );
        } finally {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
        }
    }

    async revert(
        ctx: Context,
        name: string,
        request: RevertWorkletRequest,
        expected: ExpectedWorkletDeclaration = {},
    ): Promise<StoredWorklet> {
        ctx = withDatabase(ctx, this.#database);
        if (!Value.Check(revertWorkletRequestSchema, request)) {
            throw new WorkletInvalidError("The worklet revert request is invalid.");
        }
        const reverted = await inTx(ctx, "rig.sql.worklets.store_revert", async (ctx) => {
            const worklet = await queryWorklet(ctx, name);
            if (worklet === undefined) {
                throw new WorkletNotFoundError(`No worklet named ${JSON.stringify(name)} exists.`);
            }
            if (!worklet.versions.some((version) => version.version === request.version)) {
                throw new WorkletInvalidError(
                    `The worklet ${JSON.stringify(name)} has no version ${String(request.version)}.`,
                );
            }
            const target = worklet.versions.find((version) => version.version === request.version)!;
            if (
                expected.permissions !== undefined &&
                !samePermissions(expected.permissions, target.permissions)
            ) {
                throw new WorkletInvalidError(
                    "The permissions supplied for review do not match that stored worklet version.",
                );
            }
            await workletSetCurrentVersion(ctx, name, request.version, this.#now());
            return queryWorklet(ctx, name);
        });
        if (reverted === undefined) throw new Error("The worklet was not stored.");
        return reverted;
    }

    /**
     * Removes a worklet's catalog row and every version of its code, and keeps its `Data` folder.
     * The data outlives the code that wrote it, so uninstalling never destroys it.
     */
    async remove(ctx: Context, name: string): Promise<void> {
        ctx = withDatabase(ctx, this.#database);
        return this.#serializeMutation(name, async () => {
            const existing = await queryWorklet(ctx, name);
            if (existing === undefined) {
                throw new WorkletNotFoundError(`No worklet named ${JSON.stringify(name)} exists.`);
            }
            await inTx(ctx, "rig.sql.worklets.store_remove", async (ctx) =>
                workletDelete(ctx, name),
            );
            await this.#removeCodeKeepingData(ctx, name);
        });
    }

    async readIcon(
        _ctx: Context,
        name: string,
        format: WorkletIconFormat,
    ): Promise<WorkletIconFileResult> {
        return readWorkletIcon(name, format, this.#environment);
    }

    /** Everything an import must declare about itself before any of it is copied anywhere. */
    async #readDeclaration(
        _ctx: Context,
        sourcePath: string,
        sourceReader: WorkletSourceReader,
    ): Promise<WorkletManifest> {
        const [manifest] = await Promise.all([
            readWorkletManifest(sourcePath, sourceReader, { environment: this.#environment }),
            assertWorkletDocuments(sourcePath, sourceReader),
        ]);
        return manifest;
    }

    async #install(
        ctx: Context,
        request: InstallWorkletRequest,
        manifest: WorkletManifest,
        icon: WorkletIconArtifacts,
        stagedSourcePath: string,
    ): Promise<StoredWorklet> {
        if ((await queryWorklet(ctx, manifest.name)) !== undefined) {
            throw new WorkletInvalidError(
                `A worklet named ${JSON.stringify(manifest.name)} already exists. Update it to import a new version.`,
            );
        }
        await this.#installFiles(ctx, manifest.name, stagedSourcePath, icon);
        let created;
        try {
            created = await inTx(ctx, "rig.sql.worklets.store_install", async (ctx) => {
                if ((await queryWorklet(ctx, manifest.name)) !== undefined) {
                    throw new WorkletInvalidError(
                        `A worklet named ${JSON.stringify(manifest.name)} already exists. Update it to import a new version.`,
                    );
                }
                await workletCreate(ctx, {
                    authorSessionId: request.authorSessionId,
                    changeDescription: "Initial import",
                    createdAt: this.#now(),
                    description: manifest.description,
                    iconThumbhash: icon.thumbhash,
                    name: manifest.name,
                    permissions: manifest.permissions,
                    ...(request.sourceDescription === undefined
                        ? {}
                        : { sourceDescription: request.sourceDescription }),
                });
                return queryWorklet(ctx, manifest.name);
            });
        } catch (error) {
            await this.#removeCodeKeepingData(ctx, manifest.name).catch(() => undefined);
            throw error;
        }
        if (created === undefined) throw new Error("The worklet was not stored.");
        return created;
    }

    async #update(
        ctx: Context,
        name: string,
        request: UpdateWorkletRequest,
        manifest: WorkletManifest,
        stagedSourcePath: string,
    ): Promise<StoredWorklet> {
        const existing = await queryWorklet(ctx, name);
        if (existing === undefined) {
            throw new WorkletNotFoundError(`No worklet named ${JSON.stringify(name)} exists.`);
        }
        // A worklet's name is its identity, so an import that renames it is a different worklet
        // and is refused rather than quietly taking over this one's data.
        if (manifest.name !== name) {
            throw new WorkletInvalidError(
                `The imported folder declares the worklet ${JSON.stringify(manifest.name)}, but ${JSON.stringify(name)} is being updated.`,
            );
        }
        const nextVersion =
            existing.versions.reduce((highest, version) => Math.max(highest, version.version), 0) +
            1;
        await this.#importVersion(ctx, name, nextVersion, stagedSourcePath);
        // A version folder with no catalog row behind it would make every later update collide
        // with it, so a failed write takes the folder it just landed with it.
        let updated;
        try {
            updated = await inTx(ctx, "rig.sql.worklets.store_update", async (ctx) => {
                await workletAddVersion(ctx, name, {
                    changeDescription: request.changeDescription,
                    createdAt: this.#now(),
                    description: manifest.description,
                    permissions: manifest.permissions,
                    version: nextVersion,
                });
                return queryWorklet(ctx, name);
            });
        } catch (error) {
            await rm(this.versionDirectory(name, nextVersion), {
                force: true,
                recursive: true,
            }).catch(() => undefined);
            throw error;
        }
        if (updated === undefined) throw new Error("The worklet was not stored.");
        return updated;
    }

    /**
     * Writes the icon and the first version into the worklet's folder, leaving `Data` alone.
     *
     * Code left behind by an earlier uninstall is discarded rather than merged, so an install
     * always produces exactly the imported source.
     */
    async #installFiles(
        ctx: Context,
        name: string,
        stagedSourcePath: string,
        icon: WorkletIconArtifacts,
    ): Promise<void> {
        const root = join(this.directory, name);
        await mkdir(root, { mode: 0o755, recursive: true });
        await this.#removeCodeKeepingData(ctx, name);
        const target = join(root, "v1");
        try {
            await rename(stagedSourcePath, target);
            await Promise.all([
                writeFile(join(root, "favicon.png"), icon.png),
                writeFile(join(root, "favicon.ico"), icon.ico),
            ]);
            await mkdir(join(root, DATA_FOLDER_NAME), { mode: 0o755, recursive: true });
        } catch (error) {
            await this.#removeCodeKeepingData(ctx, name).catch(() => undefined);
            if (error instanceof WorkletInvalidError) throw error;
            throw new WorkletInvalidError(
                `The worklet ${JSON.stringify(name)} could not be installed from the staged source.`,
            );
        }
    }

    async #importVersion(
        _ctx: Context,
        name: string,
        version: number,
        stagedSourcePath: string,
    ): Promise<void> {
        const root = join(this.directory, name);
        const target = join(root, `v${String(version)}`);
        // A process crash can leave a renamed version whose database transaction never committed.
        // No recorded version points at this target, so replacing that residue is safe.
        await rm(target, { force: true, recursive: true });
        try {
            await mkdir(root, { recursive: true });
            await rename(stagedSourcePath, target);
        } catch (error) {
            if (error instanceof WorkletInvalidError) throw error;
            throw new WorkletInvalidError(
                `The worklet ${JSON.stringify(name)} version import from its staged source failed.`,
            );
        }
    }

    async inspect(
        ctx: Context,
        sourcePath: string,
        sourceFileSystem?: FileSystemContext | WorkletSourceReader,
    ): Promise<WorkletManifest> {
        return this.#readDeclaration(ctx, sourcePath, resolveWorkletSourceReader(sourceFileSystem));
    }

    async #stageSource(
        _ctx: Context,
        sourcePath: string,
        sourceReader: WorkletSourceReader,
    ): Promise<string> {
        await mkdir(this.directory, { recursive: true });
        const staging = join(this.directory, `${IMPORT_STAGING_PREFIX}${randomUUID()}`);
        try {
            await mkdir(staging);
            await copyWorkletSource(sourcePath, staging, sourceReader, { mkdir, writeFile });
            return staging;
        } catch (error) {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
            throw error;
        }
    }

    #assertExpectedDeclaration(
        manifest: WorkletManifest,
        expected: ExpectedWorkletDeclaration,
    ): void {
        if (expected.name !== undefined && manifest.name !== expected.name) {
            throw new WorkletInvalidError(
                `The staged worklet is named ${JSON.stringify(manifest.name)}, but ${JSON.stringify(expected.name)} was reviewed.`,
            );
        }
        if (
            expected.permissions !== undefined &&
            !samePermissions(expected.permissions, manifest.permissions)
        ) {
            throw new WorkletInvalidError(
                "The worklet permissions supplied for review do not match the staged source manifest.",
            );
        }
    }

    async #removeCodeKeepingData(_ctx: Context, name: string): Promise<void> {
        const root = join(this.directory, name);
        let entries: readonly string[];
        try {
            entries = await readdir(root);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return;
            throw error;
        }
        await Promise.all(
            entries
                .filter((entry) => entry !== DATA_FOLDER_NAME)
                .map((entry) => rm(join(root, entry), { force: true, recursive: true })),
        );
    }

    async #readIcon(
        _ctx: Context,
        iconPath: string,
        sourceReader: WorkletSourceReader,
    ): Promise<WorkletIconArtifacts> {
        if (!isAbsolute(iconPath)) {
            throw new WorkletInvalidError(
                "The worklet icon path must be an absolute path on this machine.",
            );
        }
        let facts;
        try {
            facts = await sourceReader.lstat(iconPath);
        } catch {
            throw new WorkletInvalidError(
                `The worklet icon ${JSON.stringify(iconPath)} does not exist.`,
            );
        }
        if (facts.isSymbolicLink || !facts.isFile) {
            throw new WorkletInvalidError(
                `The worklet icon ${JSON.stringify(iconPath)} is not a regular file.`,
            );
        }
        if (facts.size > WORKLET_ICON_MAX_BYTES) {
            throw new WorkletInvalidError(
                `The worklet icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`,
            );
        }
        try {
            return await createWorkletIconArtifacts(
                await sourceReader.readFileBuffer(iconPath, {
                    maxBytes: WORKLET_ICON_MAX_BYTES,
                    noFollow: true,
                }),
            );
        } catch (error) {
            if (error instanceof WorkletIconInvalidError) {
                throw new WorkletInvalidError(error.message);
            }
            throw new WorkletInvalidError(
                `The worklet icon ${JSON.stringify(iconPath)} could not be read.`,
            );
        }
    }

    async #serializeMutation<T>(name: string, mutate: () => Promise<T>): Promise<T> {
        const previous = this.#mutationByName.get(name) ?? Promise.resolve();
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const current = previous.then(() => gate);
        this.#mutationByName.set(name, current);
        await previous;
        try {
            return await mutate();
        } finally {
            release();
            if (this.#mutationByName.get(name) === current) this.#mutationByName.delete(name);
        }
    }
}

function samePermissions(left: WorkletPermissions, right: WorkletPermissions): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export { ICON_FILE_NAMES as WORKLET_ICON_FILE_NAMES, DATA_FOLDER_NAME as WORKLET_DATA_FOLDER_NAME };
