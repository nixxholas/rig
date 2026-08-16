import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKLET_OPERATIONS,
    workletOperationSchema,
    workletSourceRefSchema,
    workletVersionNumberSchema,
    type Worklet,
    type WorkletOperation,
} from "./Worklet.js";
import {
    assertWorkletOperationList,
    assertWorkletStage,
    type WorkletStage,
    type WorkletStageInput,
} from "./WorkletStore.js";
import {
    WorkletInstallError,
    WORKLET_SOURCE_MAX_FILE_BYTES,
    copyWorkletTree,
    readBoundedFile,
} from "./copyWorkletTree.js";

/** A 512-byte cap is generous for a manifest that only declares metadata and operations. */
const WORKLET_MANIFEST_MAX_BYTES = 512 * 1024;
const WORKLET_ICON_MAX_BYTES = 4 * 1024 * 1024;
const WORKLET_MANIFEST_FILE = "worklet.json";
const WORKLET_VERSION_METADATA_FILE = ".rig-worklet-version.json";
const WORKLET_ICON_FILE = "favicon.png";
const WORKLET_DATA_DIR = "Data";
const VERSION_DIRECTORY_PATTERN = /^v[1-9][0-9]*$/;
const STAGING_VERSION_PATTERN = /^\.v[1-9][0-9]*-[0-9a-f-]+$/;
const STAGING_ICON_PATTERN = /^\.favicon-(?:orphan-)?[0-9a-f-]+\.png$/;
const WORKLET_VERSION_METADATA_MAX_BYTES = 16 * 1024;

const workletManifestOperationsSchema = Type.Array(workletOperationSchema, {
    maxItems: MAX_WORKLET_OPERATIONS,
});
const workletVersionMetadataSchema = Type.Object(
    {
        version: workletVersionNumberSchema,
        sourceRef: workletSourceRefSchema,
    },
    { additionalProperties: false },
);
type WorkletVersionMetadata = Static<typeof workletVersionMetadataSchema>;

/**
 * A 1x1 transparent PNG. A worklet is headless, so unless the source carries
 * its own `favicon.png` we still place a valid placeholder icon beside the
 * versions the way an applet's favicon sits in its root.
 */
const DEFAULT_ICON_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

interface PendingIcon {
    readonly staging: string;
    readonly target: string;
    orphan?: string;
}

interface PendingStage {
    readonly base: string;
    readonly dataDir: string;
    readonly stagingVersion: string;
    readonly targetVersionDir: string;
    readonly existingVersion: boolean;
    readonly createdBase: boolean;
    readonly createdData: boolean;
    readonly icon?: PendingIcon;
    committed: boolean;
}

export interface WorkletInstallerOptions {
    /** Absolute root the `<name>/{favicon.png,Data,v1,...}` layout is written under. */
    readonly installRoot: string;
}

/**
 * Owns the worklet filesystem. It verifies a source folder and copies it into
 * `<root>/<name>/v<n>` through a hidden staging directory. A stage is moved
 * into its final version path before the catalog is allowed to make that
 * version current; the catalog's rollback callback then removes that move if
 * its transaction fails. `Data` is created once on install and is never
 * touched by an update, revert, re-install, or remove.
 */
export class WorkletInstaller {
    readonly #installRoot: string;
    readonly #pending = new Map<string, PendingStage>();
    #resolvedInstallRoot: string | undefined;
    #reconciled: Promise<void> | undefined;

    constructor(options: WorkletInstallerOptions) {
        if (!isAbsolute(options.installRoot)) {
            throw new WorkletInstallError("The worklet install root must be an absolute path.");
        }
        this.#installRoot = resolve(options.installRoot);
    }

    /**
     * Remove temporary copy and icon entries left by a process crash. This is
     * lazy because constructors cannot await filesystem work; every operation
     * enters through this gate before it touches the install root.
     */
    async reconcile(): Promise<void> {
        await this.#ensureReconciled();
    }

    /**
     * Reconcile one worklet against the catalog generation that the caller
     * just read. A final version directory can survive a crash after the
     * filesystem rename but before the catalog write; it is safe to remove
     * only when the catalog says that version is not part of this generation.
     * With no catalog row, all code is orphaned and is removed while `Data`
     * remains available for a later reinstall.
     */
    async reconcileWorklet(
        _ctx: Context,
        name: string,
        worklet: Worklet | undefined,
    ): Promise<void> {
        await this.#ensureReconciled();
        const root = await this.#prepareRoot();
        const base = join(root, name);
        const facts = await maybeLstat(base);
        if (facts === undefined) return;
        await this.#assertRealDirectory(base, root, "worklet folder");
        if (worklet === undefined) {
            await this.#removeCodeFromBase(base, root);
            return;
        }
        const knownVersions = new Set(worklet.versions.map((version) => version.version));
        await this.#reconcileKnownBase(base, root, knownVersions);
    }

    /**
     * Verifies the source folder and copies it into a hidden staging directory
     * for the requested version, creating `Data` on the initial install. The
     * files are placed but not yet final; `commit` moves them into place and
     * `rollback` removes them.
     */
    async stage(_ctx: Context, input: WorkletStageInput): Promise<WorkletStage> {
        await this.#ensureReconciled();
        const stagingVersion = join(
            this.#installRoot,
            input.name,
            `.v${String(input.version)}-${randomUUID()}`,
        );
        let base = join(this.#installRoot, input.name);
        let dataDir = join(base, WORKLET_DATA_DIR);
        let createdBase = false;
        let createdData = false;
        let icon: PendingIcon | undefined;
        try {
            const root = await this.#prepareRoot();
            const sourcePath = await this.#resolveSource(input.sourceRef, root);
            const preparedBase = await this.#prepareBase(root, input.name);
            base = preparedBase.path;
            createdBase = preparedBase.created;
            dataDir = join(base, WORKLET_DATA_DIR);
            const dataFacts = await maybeLstat(dataDir);
            if (dataFacts === undefined) {
                await this.#assertRealDirectory(base, root, "worklet folder");
                if ((await maybeLstat(dataDir)) !== undefined) {
                    throw new WorkletInstallError(
                        `The worklet Data folder ${JSON.stringify(dataDir)} appeared before it could be created.`,
                    );
                }
                await mkdir(dataDir);
                createdData = true;
            }
            await this.#assertRealDirectory(dataDir, root, "worklet Data folder");

            const targetVersionDir = join(base, `v${String(input.version)}`);
            const targetFacts = await maybeLstat(targetVersionDir);
            const existingVersion = targetFacts !== undefined;
            if (input.reuseExisting) {
                if (!existingVersion) {
                    throw new WorkletInstallError(
                        `The worklet version ${String(input.version)} is not installed.`,
                    );
                }
                await this.#assertRealDirectory(targetVersionDir, root, "existing worklet version");
            } else {
                if (existingVersion) {
                    throw new WorkletInstallError(
                        `The worklet version ${String(input.version)} already exists; a new version must use a fresh path.`,
                    );
                }
                await copyWorkletTree(sourcePath, stagingVersion);
                await this.#assertRealDirectory(stagingVersion, root, "staged worklet version");
                await this.#writeVersionMetadata(
                    stagingVersion,
                    input.version,
                    input.sourceRef,
                    root,
                );
            }

            const versionDirectory = existingVersion ? targetVersionDir : stagingVersion;
            if (existingVersion) {
                await this.#assertVersionMetadata(targetVersionDir, input.version, input.sourceRef);
            }
            const operations = await this.#readOperations(versionDirectory);
            if (!existingVersion && input.version === 1) {
                icon = await this.#stageIcon(base, sourcePath, root);
            }
            const stage: WorkletStage = {
                stageId: randomUUID(),
                name: input.name,
                ownerAgentId: input.ownerAgentId,
                version: input.version,
                sourceRef: input.sourceRef,
                operationId: input.operationId,
                operations: [...operations],
            };
            assertWorkletStage(stage);
            this.#pending.set(stage.stageId, {
                base,
                dataDir,
                stagingVersion,
                targetVersionDir,
                existingVersion,
                createdBase,
                createdData,
                ...(icon === undefined ? {} : { icon }),
                committed: false,
            });
            return stage;
        } catch (error: unknown) {
            await this.#discard(
                stagingVersion,
                icon?.staging,
                createdBase,
                createdData,
                base,
                dataDir,
            );
            throw error;
        }
    }

    /**
     * Moves a fresh stage into its final version directory before catalog
     * mutation. Existing-version stages (reverts) only validate the directory.
     * The stage remains pending until `finalize` runs after the outer commit so
     * rollback can compensate the filesystem move.
     */
    async commit(_ctx: Context, stage: WorkletStage): Promise<void> {
        await this.#ensureReconciled();
        const pending = this.#pending.get(stage.stageId);
        if (pending === undefined) return;
        const root = await this.#prepareRoot();
        await this.#assertRealDirectory(pending.base, root, "worklet folder");
        if (pending.existingVersion) {
            pending.committed = true;
            return;
        }

        await this.#assertRealDirectory(pending.stagingVersion, root, "staged worklet version");
        const targetFacts = await maybeLstat(pending.targetVersionDir);
        if (targetFacts !== undefined) {
            throw new WorkletInstallError(
                `The worklet version ${String(stage.version)} already exists; refusing to replace it.`,
            );
        }
        if (pending.icon !== undefined) {
            await this.#assertStagedIcon(pending.icon.staging, await this.#prepareRoot());
            const targetIconFacts = await maybeLstat(pending.icon.target);
            if (targetIconFacts?.isSymbolicLink()) {
                throw new WorkletInstallError(
                    `The existing worklet icon ${JSON.stringify(pending.icon.target)} is a symbolic link.`,
                );
            }
            if (targetIconFacts !== undefined && !targetIconFacts.isFile()) {
                throw new WorkletInstallError(
                    `The existing worklet icon ${JSON.stringify(pending.icon.target)} is not a file.`,
                );
            }
        }

        // Re-check the source and its parent immediately before the rename.
        // These pathname checks are deliberately cheap hardening; see the
        // README for the residual same-account race they cannot close.
        await this.#assertRealDirectory(pending.base, root, "worklet folder");
        await this.#assertRealDirectory(pending.stagingVersion, root, "staged worklet version");
        if ((await maybeLstat(pending.targetVersionDir)) !== undefined) {
            throw new WorkletInstallError(
                `The worklet version ${String(stage.version)} appeared before it could be committed.`,
            );
        }
        await rename(pending.stagingVersion, pending.targetVersionDir);
        pending.committed = true;
        if (pending.icon !== undefined) {
            await this.#assertRealDirectory(pending.base, root, "worklet folder");
            const targetFactsAfterMove = await maybeLstat(pending.icon.target);
            if (targetFactsAfterMove !== undefined) {
                if (targetFactsAfterMove.isSymbolicLink() || !targetFactsAfterMove.isFile()) {
                    throw new WorkletInstallError(
                        `The existing worklet icon ${JSON.stringify(pending.icon.target)} is invalid.`,
                    );
                }
                pending.icon.orphan = join(pending.base, `.favicon-orphan-${randomUUID()}.png`);
                await this.#assertRealDirectory(pending.base, root, "worklet folder");
                if ((await maybeLstat(pending.icon.orphan)) !== undefined) {
                    throw new WorkletInstallError(
                        `The temporary worklet icon ${JSON.stringify(pending.icon.orphan)} already exists.`,
                    );
                }
                const targetBeforeOrphan = await maybeLstat(pending.icon.target);
                if (
                    targetBeforeOrphan === undefined ||
                    targetBeforeOrphan.isSymbolicLink() ||
                    !targetBeforeOrphan.isFile()
                ) {
                    throw new WorkletInstallError(
                        `The existing worklet icon ${JSON.stringify(pending.icon.target)} changed before it could be moved.`,
                    );
                }
                await rename(pending.icon.target, pending.icon.orphan);
            }
            await this.#assertRealDirectory(pending.base, root, "worklet folder");
            await this.#assertStagedIcon(pending.icon.staging, root);
            if ((await maybeLstat(pending.icon.target)) !== undefined) {
                throw new WorkletInstallError(
                    `The worklet icon ${JSON.stringify(pending.icon.target)} appeared before it could be committed.`,
                );
            }
            await rename(pending.icon.staging, pending.icon.target);
            if (pending.icon.orphan !== undefined) {
                await this.#removeContained(pending.icon.orphan, root);
            }
        }
    }

    /** Drops the in-memory handle after the host's outermost commit. */
    async finalize(_ctx: Context, stage: WorkletStage): Promise<void> {
        this.#pending.delete(stage.stageId);
    }

    /** Removes a stage or its pre-catalog committed version. */
    async rollback(_ctx: Context, stage: WorkletStage): Promise<void> {
        await this.#ensureReconciled();
        const pending = this.#pending.get(stage.stageId);
        if (pending === undefined) return;
        try {
            if (!pending.existingVersion) {
                if (pending.committed) {
                    await this.#removeContained(
                        pending.targetVersionDir,
                        await this.#prepareRoot(),
                    );
                } else {
                    await this.#removeContained(pending.stagingVersion, await this.#prepareRoot());
                }
                if (pending.icon !== undefined) {
                    const root = await this.#prepareRoot();
                    await this.#removeContained(pending.icon.staging, root);
                    if (pending.icon.orphan !== undefined) {
                        await this.#removeContained(pending.icon.target, root);
                        await this.#assertRealDirectory(pending.base, root, "worklet folder");
                        if ((await maybeLstat(pending.icon.target)) !== undefined) {
                            throw new WorkletInstallError(
                                `The worklet icon ${JSON.stringify(pending.icon.target)} already exists during rollback.`,
                            );
                        }
                        await this.#assertStagedIcon(pending.icon.orphan, root);
                        await rename(pending.icon.orphan, pending.icon.target);
                    } else if (pending.committed) {
                        await this.#removeContained(pending.icon.target, root);
                    }
                }
                if (pending.createdBase) {
                    await this.#removeContained(pending.base, await this.#prepareRoot());
                } else if (pending.createdData) {
                    await this.#removeContained(pending.dataDir, await this.#prepareRoot());
                }
            }
        } finally {
            this.#pending.delete(stage.stageId);
        }
    }

    /**
     * Removes a worklet's code — its icon and every version folder — while
     * keeping its `Data` folder, so a later re-install under the same name
     * finds the same durable state. Unknown or unsafe entries are refused
     * rather than followed or silently deleted.
     */
    async removeCode(_ctx: Context, name: string): Promise<void> {
        await this.#ensureReconciled();
        const root = await this.#prepareRoot();
        const base = join(root, name);
        const baseFacts = await maybeLstat(base);
        if (baseFacts === undefined) return;
        await this.#assertRealDirectory(base, root, "worklet folder");
        await this.#removeCodeFromBase(base, root);
    }

    async #removeCodeFromBase(base: string, root: string): Promise<void> {
        let directory;
        try {
            directory = await opendir(base);
        } catch {
            throw new WorkletInstallError(
                `The worklet folder ${JSON.stringify(base)} could not be read.`,
            );
        }
        try {
            for await (const entry of directory) {
                if (entry.name === WORKLET_DATA_DIR) continue;
                const child = join(base, entry.name);
                if (
                    entry.name === WORKLET_ICON_FILE ||
                    VERSION_DIRECTORY_PATTERN.test(entry.name) ||
                    STAGING_VERSION_PATTERN.test(entry.name) ||
                    STAGING_ICON_PATTERN.test(entry.name)
                ) {
                    const facts = await lstat(child);
                    if (facts.isSymbolicLink()) {
                        throw new WorkletInstallError(
                            `The worklet entry ${JSON.stringify(child)} is a symbolic link.`,
                        );
                    }
                    if (VERSION_DIRECTORY_PATTERN.test(entry.name)) {
                        await this.#assertRealDirectory(child, root, "worklet version");
                    }
                    await this.#removeContained(child, root);
                    continue;
                }
                throw new WorkletInstallError(
                    `The worklet folder contains an unexpected entry ${JSON.stringify(entry.name)}.`,
                );
            }
        } finally {
            await directory.close().catch(() => undefined);
        }
    }

    async #reconcileKnownBase(
        base: string,
        root: string,
        knownVersions: ReadonlySet<number>,
    ): Promise<void> {
        let directory;
        try {
            directory = await opendir(base);
        } catch {
            throw new WorkletInstallError(
                `The worklet folder ${JSON.stringify(base)} could not be read.`,
            );
        }
        try {
            for await (const entry of directory) {
                if (
                    STAGING_VERSION_PATTERN.test(entry.name) ||
                    STAGING_ICON_PATTERN.test(entry.name)
                ) {
                    await this.#removeContained(join(base, entry.name), root);
                    continue;
                }
                const match = /^v([1-9][0-9]*)$/.exec(entry.name);
                if (match === null) continue;
                const version = Number(match[1]);
                if (!knownVersions.has(version)) {
                    await this.#removeContained(join(base, entry.name), root);
                    continue;
                }
                await this.#assertRealDirectory(join(base, entry.name), root, "worklet version");
            }
        } finally {
            await directory.close().catch(() => undefined);
        }
    }

    async #ensureReconciled(): Promise<void> {
        if (this.#reconciled === undefined) {
            const work = this.#reconcileRoot();
            this.#reconciled = work.catch((error: unknown) => {
                this.#reconciled = undefined;
                throw error;
            });
        }
        await this.#reconciled;
    }

    async #reconcileRoot(): Promise<void> {
        const root = await this.#prepareRoot();
        let directory;
        try {
            directory = await opendir(root);
        } catch {
            throw new WorkletInstallError(
                `The worklet install root ${JSON.stringify(root)} could not be read.`,
            );
        }
        try {
            for await (const entry of directory) {
                const base = join(root, entry.name);
                const facts = await lstat(base);
                if (facts.isSymbolicLink() || !facts.isDirectory()) continue;
                await this.#assertRealDirectory(base, root, "worklet folder");
                await this.#reconcileBase(base, root);
            }
        } finally {
            await directory.close().catch(() => undefined);
        }
    }

    async #reconcileBase(base: string, root: string): Promise<void> {
        let directory;
        try {
            directory = await opendir(base);
        } catch {
            throw new WorkletInstallError(
                `The worklet folder ${JSON.stringify(base)} could not be read.`,
            );
        }
        try {
            for await (const entry of directory) {
                if (
                    !STAGING_VERSION_PATTERN.test(entry.name) &&
                    !STAGING_ICON_PATTERN.test(entry.name)
                ) {
                    continue;
                }
                const child = join(base, entry.name);
                const facts = await lstat(child);
                if (facts.isSymbolicLink()) {
                    throw new WorkletInstallError(
                        `The temporary worklet entry ${JSON.stringify(child)} is a symbolic link.`,
                    );
                }
                await this.#removeContained(child, root);
            }
        } finally {
            await directory.close().catch(() => undefined);
        }
    }

    async #prepareRoot(): Promise<string> {
        const parent = await maybeLstat(dirname(this.#installRoot));
        if (parent !== undefined && (parent.isSymbolicLink() || !parent.isDirectory())) {
            throw new WorkletInstallError(
                `The parent of the worklet install root ${JSON.stringify(this.#installRoot)} is not a real folder.`,
            );
        }
        const existingRoot = await maybeLstat(this.#installRoot);
        if (
            existingRoot !== undefined &&
            (existingRoot.isSymbolicLink() || !existingRoot.isDirectory())
        ) {
            throw new WorkletInstallError(
                `The worklet install root ${JSON.stringify(this.#installRoot)} is not a real folder.`,
            );
        }
        await mkdir(this.#installRoot, { recursive: true });
        const facts = await lstat(this.#installRoot);
        if (facts.isSymbolicLink() || !facts.isDirectory()) {
            throw new WorkletInstallError(
                `The worklet install root ${JSON.stringify(this.#installRoot)} is not a real folder.`,
            );
        }
        const resolved = await realpath(this.#installRoot);
        this.#resolvedInstallRoot = resolved;
        return resolved;
    }

    async #prepareBase(
        root: string,
        name: string,
    ): Promise<{ readonly path: string; readonly created: boolean }> {
        const path = join(root, name);
        const facts = await maybeLstat(path);
        let created = false;
        if (facts === undefined) {
            await this.#assertRealDirectory(root, root, "worklet install root");
            if ((await maybeLstat(path)) !== undefined) {
                throw new WorkletInstallError(
                    `The worklet folder ${JSON.stringify(path)} appeared before it could be created.`,
                );
            }
            await mkdir(path);
            created = true;
        }
        await this.#assertRealDirectory(path, root, "worklet folder");
        return { path, created };
    }

    async #resolveSource(sourceRef: string, root: string): Promise<string> {
        if (!isAbsolute(sourceRef)) {
            throw new WorkletInstallError(
                "The worklet source path must be an absolute folder path on this machine.",
            );
        }
        const sourceFacts = await maybeLstat(sourceRef);
        if (sourceFacts === undefined) {
            throw new WorkletInstallError(
                `The worklet source folder ${JSON.stringify(sourceRef)} does not exist.`,
            );
        }
        if (sourceFacts.isSymbolicLink() || !sourceFacts.isDirectory()) {
            throw new WorkletInstallError(
                `The worklet source ${JSON.stringify(sourceRef)} is not a real folder.`,
            );
        }
        const resolved = await realpath(sourceRef);
        if (pathsOverlap(root, resolved)) {
            throw new WorkletInstallError(
                "The worklet source and install root must not contain one another.",
            );
        }
        const resolvedFacts = await lstat(resolved);
        if (resolvedFacts.isSymbolicLink() || !resolvedFacts.isDirectory()) {
            throw new WorkletInstallError(
                `The worklet source ${JSON.stringify(sourceRef)} is not a real folder.`,
            );
        }
        return resolved;
    }

    async #assertRealDirectory(path: string, root: string, label: string): Promise<void> {
        const facts = await lstat(path);
        if (facts.isSymbolicLink() || !facts.isDirectory()) {
            throw new WorkletInstallError(`${label} ${JSON.stringify(path)} is not a real folder.`);
        }
        const resolved = await realpath(path);
        if (!isContained(root, resolved)) {
            throw new WorkletInstallError(
                `${label} ${JSON.stringify(path)} escapes the worklet install root.`,
            );
        }
    }

    async #assertStagedIcon(path: string, root: string): Promise<void> {
        const facts = await lstat(path);
        if (facts.isSymbolicLink() || !facts.isFile()) {
            throw new WorkletInstallError(
                `The staged worklet icon ${JSON.stringify(path)} is invalid.`,
            );
        }
        const resolvedParent = await realpath(join(path, ".."));
        if (!isContained(root, resolvedParent)) {
            throw new WorkletInstallError(
                `The staged worklet icon ${JSON.stringify(path)} escapes the install root.`,
            );
        }
    }

    async #removeContained(path: string, root: string): Promise<void> {
        const lexical = resolve(path);
        if (!isContained(root, lexical) && !isContained(this.#installRoot, lexical)) {
            throw new WorkletInstallError(
                `Refusing to remove a worklet path outside the install root: ${JSON.stringify(path)}.`,
            );
        }
        const facts = await maybeLstat(path);
        if (facts === undefined) return;
        if (facts.isSymbolicLink()) {
            throw new WorkletInstallError(
                `Refusing to remove a symbolic-link worklet path: ${JSON.stringify(path)}.`,
            );
        }
        const resolved = await realpath(path);
        if (!isContained(root, resolved)) {
            throw new WorkletInstallError(
                `Refusing to remove a worklet path that escapes the install root: ${JSON.stringify(path)}.`,
            );
        }
        // Re-check immediately before the destructive operation. This is
        // containment hardening, not an openat-equivalent race proof.
        const finalFacts = await lstat(path);
        if (
            finalFacts.isSymbolicLink() ||
            finalFacts.isDirectory() !== facts.isDirectory() ||
            finalFacts.isFile() !== facts.isFile()
        ) {
            throw new WorkletInstallError(
                `The worklet path changed before removal: ${JSON.stringify(path)}.`,
            );
        }
        const finalResolved = await realpath(path);
        if (!isContained(root, finalResolved)) {
            throw new WorkletInstallError(
                `Refusing to remove a worklet path that escapes the install root: ${JSON.stringify(path)}.`,
            );
        }
        await rm(path, { force: false, recursive: finalFacts.isDirectory() });
    }

    async #stageIcon(base: string, sourcePath: string, root: string): Promise<PendingIcon> {
        const bytes = await this.#readIconBytes(sourcePath);
        const staging = join(base, `.favicon-${randomUUID()}.png`);
        try {
            await this.#assertRealDirectory(base, root, "worklet folder");
            if ((await maybeLstat(staging)) !== undefined) {
                throw new WorkletInstallError(
                    `The temporary worklet icon ${JSON.stringify(staging)} already exists.`,
                );
            }
            await writeFile(staging, bytes, { flag: "wx" });
            await this.#assertStagedIcon(staging, root);
            return { staging, target: join(base, WORKLET_ICON_FILE) };
        } catch (error: unknown) {
            await this.#removeContained(staging, root).catch(() => undefined);
            throw error;
        }
    }

    async #readIconBytes(sourcePath: string): Promise<Buffer> {
        const iconPath = join(sourcePath, WORKLET_ICON_FILE);
        let facts;
        try {
            facts = await lstat(iconPath);
        } catch {
            return DEFAULT_ICON_PNG;
        }
        if (facts.isSymbolicLink() || !facts.isFile()) return DEFAULT_ICON_PNG;
        if (facts.size > WORKLET_ICON_MAX_BYTES) {
            throw new WorkletInstallError(
                `The worklet icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`,
            );
        }
        return readBoundedFile(iconPath, WORKLET_ICON_MAX_BYTES);
    }

    async #readOperations(versionDir: string): Promise<readonly WorkletOperation[]> {
        const manifestPath = join(versionDir, WORKLET_MANIFEST_FILE);
        const facts = await maybeLstat(manifestPath);
        if (facts === undefined) return [];
        if (facts.isSymbolicLink() || !facts.isFile()) {
            throw new WorkletInstallError(
                `The worklet manifest ${JSON.stringify(WORKLET_MANIFEST_FILE)} is not a regular file.`,
            );
        }
        const bytes = await readBoundedFile(manifestPath, WORKLET_MANIFEST_MAX_BYTES);
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
            throw new WorkletInstallError(
                `The worklet manifest ${JSON.stringify(WORKLET_MANIFEST_FILE)} is not valid JSON.`,
            );
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new WorkletInstallError(
                `The worklet manifest ${JSON.stringify(WORKLET_MANIFEST_FILE)} must be a JSON object.`,
            );
        }
        const declared = (parsed as { operations?: unknown }).operations;
        if (declared === undefined) return [];
        if (!Value.Check(workletManifestOperationsSchema, declared)) {
            throw new WorkletInstallError("The worklet manifest declares invalid operations.");
        }
        try {
            assertWorkletOperationList(declared);
        } catch {
            throw new WorkletInstallError(
                "The worklet manifest declares duplicate operation names.",
            );
        }
        return declared as readonly WorkletOperation[];
    }

    async #writeVersionMetadata(
        versionDir: string,
        version: number,
        sourceRef: string,
        root: string,
    ): Promise<void> {
        const metadataPath = join(versionDir, WORKLET_VERSION_METADATA_FILE);
        const metadata = { version, sourceRef };
        if (!Value.Check(workletVersionMetadataSchema, metadata)) {
            throw new WorkletInstallError("The worklet version metadata is invalid.");
        }
        try {
            await this.#assertRealDirectory(versionDir, root, "staged worklet version");
            if ((await maybeLstat(metadataPath)) !== undefined) {
                throw new WorkletInstallError(
                    `The worklet version metadata ${JSON.stringify(metadataPath)} already exists.`,
                );
            }
            await writeFile(metadataPath, JSON.stringify(metadata), { flag: "wx" });
        } catch {
            throw new WorkletInstallError(
                `The worklet version metadata ${JSON.stringify(metadataPath)} could not be written.`,
            );
        }
        const facts = await lstat(metadataPath);
        if (facts.isSymbolicLink() || !facts.isFile()) {
            throw new WorkletInstallError(
                `The worklet version metadata ${JSON.stringify(metadataPath)} is not a regular file.`,
            );
        }
        const parent = await realpath(join(metadataPath, ".."));
        if (!isContained(root, parent)) {
            throw new WorkletInstallError(
                `The worklet version metadata ${JSON.stringify(metadataPath)} escapes the install root.`,
            );
        }
    }

    async #assertVersionMetadata(
        versionDir: string,
        version: number,
        sourceRef: string,
    ): Promise<void> {
        const metadataPath = join(versionDir, WORKLET_VERSION_METADATA_FILE);
        const facts = await maybeLstat(metadataPath);
        if (facts === undefined || facts.isSymbolicLink() || !facts.isFile()) {
            throw new WorkletInstallError(
                `The existing worklet version ${String(version)} has no valid provenance metadata.`,
            );
        }
        const bytes = await readBoundedFile(metadataPath, WORKLET_VERSION_METADATA_MAX_BYTES);
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
            throw new WorkletInstallError(
                `The existing worklet version ${String(version)} has invalid provenance metadata.`,
            );
        }
        if (!Value.Check(workletVersionMetadataSchema, parsed)) {
            throw new WorkletInstallError(
                `The existing worklet version ${String(version)} has mismatched provenance metadata.`,
            );
        }
        const metadata = parsed as WorkletVersionMetadata;
        if (metadata.version !== version || metadata.sourceRef !== sourceRef) {
            throw new WorkletInstallError(
                `The existing worklet version ${String(version)} has mismatched provenance metadata.`,
            );
        }
    }

    async #discard(
        stagingVersion: string,
        iconStaging: string | undefined,
        createdBase: boolean,
        createdData: boolean,
        base: string,
        dataDir: string,
    ): Promise<void> {
        const root = this.#resolvedInstallRoot ?? this.#installRoot;
        await this.#removeContained(stagingVersion, root).catch(() => undefined);
        if (iconStaging !== undefined) {
            await this.#removeContained(iconStaging, root).catch(() => undefined);
        }
        if (createdBase) {
            await this.#removeContained(base, root).catch(() => undefined);
        } else if (createdData) {
            await this.#removeContained(dataDir, root).catch(() => undefined);
        }
    }
}

async function maybeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
        return await lstat(path);
    } catch (error: unknown) {
        if (isNotFound(error)) return undefined;
        throw error;
    }
}

function isNotFound(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
    );
}

function isContained(root: string, target: string): boolean {
    const rootPath = resolve(root);
    const targetPath = resolve(target);
    const child = relative(rootPath, targetPath);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function pathsOverlap(left: string, right: string): boolean {
    return isContained(left, right) || isContained(right, left);
}
