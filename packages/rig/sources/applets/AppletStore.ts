import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { inTx } from "../persistence/inTx.js";
import type { TX } from "../persistence/Transaction.js";
import { queryApplet } from "../persistence/applets/queryApplet.js";
import { queryApplets } from "../persistence/applets/queryApplets.js";
import { appletAddVersion } from "../persistence/applets/appletAddVersion.js";
import { appletCreate } from "../persistence/applets/appletCreate.js";
import { appletSetCurrentVersion } from "../persistence/applets/appletSetCurrentVersion.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import {
    createAppletRequestSchema,
    defaultAppletAllowedScopes,
    revertAppletRequestSchema,
    updateAppletRequestSchema,
    type CreateAppletRequest,
    type RevertAppletRequest,
    type UpdateAppletRequest,
    type Applet,
    type AppletsChangedEvent,
} from "../protocol/AppletProtocol.js";
import { getAppletsDirectory } from "./getAppletsDirectory.js";
import { isValidAppletName } from "./isValidAppletName.js";
import {
    createAppletIconArtifacts,
    APPLET_ICON_MAX_BYTES,
    AppletIconInvalidError,
} from "./AppletIcon.js";
import { AppletInvalidError } from "./AppletInvalidError.js";
import { AppletNotFoundError } from "./AppletNotFoundError.js";
import {
    copyAppletSource,
    resolveAppletSourceReader,
    type AppletSourceReader,
} from "./copyAppletSource.js";
import {
    readAppletIcon,
    type AppletIconFileResult,
    type AppletIconFormat,
} from "./readAppletIcon.js";

export interface AppletStoreOptions {
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    /** Delivers a change to the live global stream after the database write committed. */
    publish: (event: AppletsChangedEvent) => void;
    tx: () => TX;
}

/**
 * Owns every applet: imported source folders rig serves as static files.
 *
 * An applet is only ever created or updated by importing a source folder; nothing writes into the
 * applet data folder directly. Each import is copied into its own `v<n>` directory before the
 * version is recorded, so the database never points at files that are not fully in place. One
 * version is current, and reverting moves that pointer without deleting anything. Every change
 * publishes `applets_changed` with the whole current set.
 */
export class AppletStore {
    readonly #createEventId = createEventIdFactory();
    readonly #environment: NodeJS.ProcessEnv;
    readonly #now: () => number;
    readonly #publish: (event: AppletsChangedEvent) => void;
    readonly #tx: () => TX;
    readonly #mutationByName = new Map<string, Promise<void>>();

    constructor(options: AppletStoreOptions) {
        this.#environment = options.environment ?? process.env;
        this.#now = options.now ?? Date.now;
        this.#publish = options.publish;
        this.#tx = options.tx;
    }

    async create(
        request: CreateAppletRequest,
        sourceFileSystem?: FileSystemContext | AppletSourceReader,
    ): Promise<Applet> {
        return this.#serializeMutation(request.name, () => this.#create(request, sourceFileSystem));
    }

    async #create(
        request: CreateAppletRequest,
        sourceFileSystem?: FileSystemContext | AppletSourceReader,
    ): Promise<Applet> {
        if (!Value.Check(createAppletRequestSchema, request)) {
            throw new AppletInvalidError("The applet import request is invalid.");
        }
        if (!isValidAppletName(request.name)) {
            throw new AppletInvalidError(
                `An applet name must be kebab-case, such as "usage-dashboard". Got ${JSON.stringify(request.name)}.`,
            );
        }
        if (queryApplet(this.#tx(), request.name) !== undefined) {
            throw new AppletInvalidError(
                `An applet named ${JSON.stringify(request.name)} already exists. Update it to import a new version.`,
            );
        }
        const sourceReader = resolveAppletSourceReader(sourceFileSystem);
        const icon = await this.#readIcon(request.iconPath, sourceReader);
        const files = await this.#createFiles(request.name, request.path, icon, sourceReader);
        let created;
        try {
            created = inTx(this.#tx(), (tx) => {
                if (queryApplet(tx, request.name) !== undefined) {
                    throw new AppletInvalidError(
                        `An applet named ${JSON.stringify(request.name)} already exists. Update it to import a new version.`,
                    );
                }
                appletCreate(tx, {
                    allowedScopes: request.allowedScopes ?? [...defaultAppletAllowedScopes],
                    authorSessionId: request.authorSessionId,
                    changeDescription: "Initial import",
                    createdAt: this.#now(),
                    description: request.description,
                    iconThumbhash: icon.thumbhash,
                    name: request.name,
                    purpose: request.purpose,
                    ...(request.sourceDescription === undefined
                        ? {}
                        : { sourceDescription: request.sourceDescription }),
                });
                return queryApplet(tx, request.name);
            });
        } catch (error) {
            await files.rollback();
            throw error;
        }
        this.#publishChanged();
        if (created === undefined) throw new Error("The applet was not stored.");
        return created;
    }

    get(name: string): Applet | undefined {
        return queryApplet(this.#tx(), name);
    }

    list(): readonly Applet[] {
        return queryApplets(this.#tx());
    }

    revert(name: string, request: RevertAppletRequest): Applet {
        if (!Value.Check(revertAppletRequestSchema, request)) {
            throw new AppletInvalidError("The applet revert request is invalid.");
        }
        const reverted = inTx(this.#tx(), (tx) => {
            const applet = queryApplet(tx, name);
            if (applet === undefined) {
                throw new AppletNotFoundError(`No applet named ${JSON.stringify(name)} exists.`);
            }
            if (!applet.versions.some((version) => version.version === request.version)) {
                throw new AppletInvalidError(
                    `The applet ${JSON.stringify(name)} has no version ${String(request.version)}.`,
                );
            }
            appletSetCurrentVersion(tx, name, request.version, this.#now());
            return queryApplet(tx, name);
        });
        this.#publishChanged();
        if (reverted === undefined) throw new Error("The applet was not stored.");
        return reverted;
    }

    async update(
        name: string,
        request: UpdateAppletRequest,
        sourceFileSystem?: FileSystemContext | AppletSourceReader,
    ): Promise<Applet> {
        return this.#serializeMutation(name, () => this.#update(name, request, sourceFileSystem));
    }

    async #update(
        name: string,
        request: UpdateAppletRequest,
        sourceFileSystem?: FileSystemContext | AppletSourceReader,
    ): Promise<Applet> {
        if (!Value.Check(updateAppletRequestSchema, request)) {
            throw new AppletInvalidError(
                "An applet update needs the source folder path and a description of the change.",
            );
        }
        const existing = queryApplet(this.#tx(), name);
        if (existing === undefined) {
            throw new AppletNotFoundError(`No applet named ${JSON.stringify(name)} exists.`);
        }
        const nextVersion =
            existing.versions.reduce((highest, version) => Math.max(highest, version.version), 0) +
            1;
        await this.#importVersion(
            name,
            nextVersion,
            request.path,
            resolveAppletSourceReader(sourceFileSystem),
        );
        const updated = inTx(this.#tx(), (tx) => {
            appletAddVersion(
                tx,
                name,
                nextVersion,
                request.changeDescription,
                this.#now(),
                request.allowedScopes,
            );
            return queryApplet(tx, name);
        });
        this.#publishChanged();
        if (updated === undefined) throw new Error("The applet was not stored.");
        return updated;
    }

    async readIcon(name: string, format: AppletIconFormat): Promise<AppletIconFileResult> {
        return readAppletIcon(name, format, this.#environment);
    }

    async #createFiles(
        name: string,
        sourcePath: string,
        icon: Awaited<ReturnType<typeof createAppletIconArtifacts>>,
        sourceReader: AppletSourceReader,
    ): Promise<{ rollback: () => Promise<void> }> {
        const root = getAppletsDirectory(this.#environment);
        const target = join(root, name);
        await mkdir(root, { recursive: true });
        const orphan = await this.#moveExistingTargetAside(target, name, root);
        const staging = join(root, `.${name}-${randomUUID()}`);
        try {
            await mkdir(staging);
            await copyAppletSource(sourcePath, join(staging, "v1"), sourceReader, {
                mkdir,
                writeFile,
            });
            await Promise.all([
                writeFile(join(staging, "favicon.png"), icon.png),
                writeFile(join(staging, "favicon.ico"), icon.ico),
            ]);
            await rename(staging, target);
            return {
                rollback: async () => {
                    await rm(target, { force: true, recursive: true });
                    if (orphan !== undefined) await rename(orphan, target);
                },
            };
        } catch (error) {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
            if (orphan !== undefined) {
                await rename(orphan, target).catch(() => undefined);
            }
            if (error instanceof AppletInvalidError) throw error;
            throw new AppletInvalidError(
                `The applet ${JSON.stringify(name)} could not be imported from ${JSON.stringify(sourcePath)}.`,
            );
        }
    }

    async #importVersion(
        name: string,
        version: number,
        sourcePath: string,
        sourceReader: AppletSourceReader,
    ): Promise<void> {
        const root = join(getAppletsDirectory(this.#environment), name);
        const target = join(root, `v${String(version)}`);
        await this.#assertMissingTarget(target, name);
        const staging = join(root, `.v${String(version)}-${randomUUID()}`);
        try {
            await mkdir(root, { recursive: true });
            await mkdir(staging);
            await copyAppletSource(sourcePath, staging, sourceReader, { mkdir, writeFile });
            await rename(staging, target);
        } catch (error) {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
            if (error instanceof AppletInvalidError) throw error;
            throw new AppletInvalidError(
                `The applet ${JSON.stringify(name)} version import from ${JSON.stringify(sourcePath)} failed.`,
            );
        }
    }

    async #readIcon(
        iconPath: string,
        sourceReader: AppletSourceReader,
    ): Promise<Awaited<ReturnType<typeof createAppletIconArtifacts>>> {
        if (!isAbsolute(iconPath)) {
            throw new AppletInvalidError(
                "The applet icon path must be an absolute path on this machine.",
            );
        }
        let facts;
        try {
            facts = await sourceReader.lstat(iconPath);
        } catch {
            throw new AppletInvalidError(
                `The applet icon ${JSON.stringify(iconPath)} does not exist.`,
            );
        }
        if (facts.isSymbolicLink || !facts.isFile) {
            throw new AppletInvalidError(
                `The applet icon ${JSON.stringify(iconPath)} is not a regular file.`,
            );
        }
        if (facts.size > APPLET_ICON_MAX_BYTES) {
            throw new AppletInvalidError(
                `The applet icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`,
            );
        }
        try {
            return await createAppletIconArtifacts(
                await sourceReader.readFileBuffer(iconPath, {
                    maxBytes: APPLET_ICON_MAX_BYTES,
                    noFollow: true,
                }),
            );
        } catch (error) {
            if (error instanceof AppletIconInvalidError) {
                throw new AppletInvalidError(error.message);
            }
            throw new AppletInvalidError(
                `The applet icon ${JSON.stringify(iconPath)} could not be read.`,
            );
        }
    }

    async #assertMissingTarget(target: string, name: string): Promise<void> {
        try {
            await lstat(target);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            throw error;
        }
        throw new AppletInvalidError(
            `The applet data directory for ${JSON.stringify(name)} already exists.`,
        );
    }

    async #moveExistingTargetAside(
        target: string,
        name: string,
        root: string,
    ): Promise<string | undefined> {
        try {
            await lstat(target);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return undefined;
            throw error;
        }
        const orphan = join(root, `.${name}-orphan-${randomUUID()}`);
        await rename(target, orphan);
        return orphan;
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

    #publishChanged(): void {
        this.#publish({
            createdAt: this.#now(),
            data: { applets: this.list() },
            id: this.#createEventId(),
            type: "applets_changed",
        });
    }
}
