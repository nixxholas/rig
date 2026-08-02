import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import { inTx } from "../persistence/inTx.js";
import type { TX } from "../persistence/Transaction.js";
import { queryWebapp } from "../persistence/webapps/queryWebapp.js";
import { queryWebapps } from "../persistence/webapps/queryWebapps.js";
import { webappAddVersion } from "../persistence/webapps/webappAddVersion.js";
import { webappCreate } from "../persistence/webapps/webappCreate.js";
import { webappSetCurrentVersion } from "../persistence/webapps/webappSetCurrentVersion.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import {
    createWebappRequestSchema,
    revertWebappRequestSchema,
    updateWebappRequestSchema,
    type CreateWebappRequest,
    type RevertWebappRequest,
    type UpdateWebappRequest,
    type Webapp,
    type WebappsChangedEvent,
} from "../protocol/WebappProtocol.js";
import { getWebappsDirectory } from "./getWebappsDirectory.js";
import { isValidWebappName } from "./isValidWebappName.js";
import {
    createWebappIconArtifacts,
    WEBAPP_ICON_MAX_BYTES,
    WebappIconInvalidError,
} from "./WebappIcon.js";
import { WebappInvalidError } from "./WebappInvalidError.js";
import { WebappNotFoundError } from "./WebappNotFoundError.js";
import {
    copyWebappSource,
    resolveWebappSourceReader,
    type WebappSourceReader,
} from "./copyWebappSource.js";
import {
    readWebappIcon,
    type WebappIconFileResult,
    type WebappIconFormat,
} from "./readWebappIcon.js";

export interface WebappStoreOptions {
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    /** Delivers a change to the live global stream after the database write committed. */
    publish: (event: WebappsChangedEvent) => void;
    tx: () => TX;
}

/**
 * Owns every webapp: imported source folders rig serves as static files.
 *
 * A webapp is only ever created or updated by importing a source folder; nothing writes into the
 * webapp data folder directly. Each import is copied into its own `v<n>` directory before the
 * version is recorded, so the database never points at files that are not fully in place. One
 * version is current, and reverting moves that pointer without deleting anything. Every change
 * publishes `webapps_changed` with the whole current set.
 */
export class WebappStore {
    readonly #createEventId = createEventIdFactory();
    readonly #environment: NodeJS.ProcessEnv;
    readonly #now: () => number;
    readonly #publish: (event: WebappsChangedEvent) => void;
    readonly #tx: () => TX;
    readonly #mutationByName = new Map<string, Promise<void>>();

    constructor(options: WebappStoreOptions) {
        this.#environment = options.environment ?? process.env;
        this.#now = options.now ?? Date.now;
        this.#publish = options.publish;
        this.#tx = options.tx;
    }

    async create(
        request: CreateWebappRequest,
        sourceFileSystem?: FileSystemContext | WebappSourceReader,
    ): Promise<Webapp> {
        return this.#serializeMutation(request.name, () => this.#create(request, sourceFileSystem));
    }

    async #create(
        request: CreateWebappRequest,
        sourceFileSystem?: FileSystemContext | WebappSourceReader,
    ): Promise<Webapp> {
        if (!Value.Check(createWebappRequestSchema, request)) {
            throw new WebappInvalidError("The webapp import request is invalid.");
        }
        if (!isValidWebappName(request.name)) {
            throw new WebappInvalidError(
                `A webapp name must be kebab-case, such as "usage-dashboard". Got ${JSON.stringify(request.name)}.`,
            );
        }
        if (queryWebapp(this.#tx(), request.name) !== undefined) {
            throw new WebappInvalidError(
                `A webapp named ${JSON.stringify(request.name)} already exists. Update it to import a new version.`,
            );
        }
        const sourceReader = resolveWebappSourceReader(sourceFileSystem);
        const icon = await this.#readIcon(request.iconPath, sourceReader);
        const files = await this.#createFiles(request.name, request.path, icon, sourceReader);
        let created;
        try {
            created = inTx(this.#tx(), (tx) => {
                if (queryWebapp(tx, request.name) !== undefined) {
                    throw new WebappInvalidError(
                        `A webapp named ${JSON.stringify(request.name)} already exists. Update it to import a new version.`,
                    );
                }
                webappCreate(tx, {
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
                return queryWebapp(tx, request.name);
            });
        } catch (error) {
            await files.rollback();
            throw error;
        }
        this.#publishChanged();
        if (created === undefined) throw new Error("The webapp was not stored.");
        return created;
    }

    get(name: string): Webapp | undefined {
        return queryWebapp(this.#tx(), name);
    }

    list(): readonly Webapp[] {
        return queryWebapps(this.#tx());
    }

    revert(name: string, request: RevertWebappRequest): Webapp {
        if (!Value.Check(revertWebappRequestSchema, request)) {
            throw new WebappInvalidError("The webapp revert request is invalid.");
        }
        const reverted = inTx(this.#tx(), (tx) => {
            const webapp = queryWebapp(tx, name);
            if (webapp === undefined) {
                throw new WebappNotFoundError(`No webapp named ${JSON.stringify(name)} exists.`);
            }
            if (!webapp.versions.some((version) => version.version === request.version)) {
                throw new WebappInvalidError(
                    `The webapp ${JSON.stringify(name)} has no version ${String(request.version)}.`,
                );
            }
            webappSetCurrentVersion(tx, name, request.version, this.#now());
            return queryWebapp(tx, name);
        });
        this.#publishChanged();
        if (reverted === undefined) throw new Error("The webapp was not stored.");
        return reverted;
    }

    async update(
        name: string,
        request: UpdateWebappRequest,
        sourceFileSystem?: FileSystemContext | WebappSourceReader,
    ): Promise<Webapp> {
        return this.#serializeMutation(name, () => this.#update(name, request, sourceFileSystem));
    }

    async #update(
        name: string,
        request: UpdateWebappRequest,
        sourceFileSystem?: FileSystemContext | WebappSourceReader,
    ): Promise<Webapp> {
        if (!Value.Check(updateWebappRequestSchema, request)) {
            throw new WebappInvalidError(
                "A webapp update needs the source folder path and a description of the change.",
            );
        }
        const existing = queryWebapp(this.#tx(), name);
        if (existing === undefined) {
            throw new WebappNotFoundError(`No webapp named ${JSON.stringify(name)} exists.`);
        }
        const nextVersion =
            existing.versions.reduce((highest, version) => Math.max(highest, version.version), 0) +
            1;
        await this.#importVersion(
            name,
            nextVersion,
            request.path,
            resolveWebappSourceReader(sourceFileSystem),
        );
        const updated = inTx(this.#tx(), (tx) => {
            webappAddVersion(tx, name, nextVersion, request.changeDescription, this.#now());
            return queryWebapp(tx, name);
        });
        this.#publishChanged();
        if (updated === undefined) throw new Error("The webapp was not stored.");
        return updated;
    }

    async readIcon(name: string, format: WebappIconFormat): Promise<WebappIconFileResult> {
        return readWebappIcon(name, format, this.#environment);
    }

    async #createFiles(
        name: string,
        sourcePath: string,
        icon: Awaited<ReturnType<typeof createWebappIconArtifacts>>,
        sourceReader: WebappSourceReader,
    ): Promise<{ rollback: () => Promise<void> }> {
        const root = getWebappsDirectory(this.#environment);
        const target = join(root, name);
        await mkdir(root, { recursive: true });
        const orphan = await this.#moveExistingTargetAside(target, name, root);
        const staging = join(root, `.${name}-${randomUUID()}`);
        try {
            await mkdir(staging);
            await copyWebappSource(sourcePath, join(staging, "v1"), sourceReader, {
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
            if (error instanceof WebappInvalidError) throw error;
            throw new WebappInvalidError(
                `The webapp ${JSON.stringify(name)} could not be imported from ${JSON.stringify(sourcePath)}.`,
            );
        }
    }

    async #importVersion(
        name: string,
        version: number,
        sourcePath: string,
        sourceReader: WebappSourceReader,
    ): Promise<void> {
        const root = join(getWebappsDirectory(this.#environment), name);
        const target = join(root, `v${String(version)}`);
        await this.#assertMissingTarget(target, name);
        const staging = join(root, `.v${String(version)}-${randomUUID()}`);
        try {
            await mkdir(root, { recursive: true });
            await mkdir(staging);
            await copyWebappSource(sourcePath, staging, sourceReader, { mkdir, writeFile });
            await rename(staging, target);
        } catch (error) {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
            if (error instanceof WebappInvalidError) throw error;
            throw new WebappInvalidError(
                `The webapp ${JSON.stringify(name)} version import from ${JSON.stringify(sourcePath)} failed.`,
            );
        }
    }

    async #readIcon(
        iconPath: string,
        sourceReader: WebappSourceReader,
    ): Promise<Awaited<ReturnType<typeof createWebappIconArtifacts>>> {
        if (!isAbsolute(iconPath)) {
            throw new WebappInvalidError(
                "The webapp icon path must be an absolute path on this machine.",
            );
        }
        let facts;
        try {
            facts = await sourceReader.lstat(iconPath);
        } catch {
            throw new WebappInvalidError(
                `The webapp icon ${JSON.stringify(iconPath)} does not exist.`,
            );
        }
        if (facts.isSymbolicLink || !facts.isFile) {
            throw new WebappInvalidError(
                `The webapp icon ${JSON.stringify(iconPath)} is not a regular file.`,
            );
        }
        if (facts.size > WEBAPP_ICON_MAX_BYTES) {
            throw new WebappInvalidError(
                `The webapp icon ${JSON.stringify(iconPath)} exceeds the 4 MiB limit.`,
            );
        }
        try {
            return await createWebappIconArtifacts(
                await sourceReader.readFileBuffer(iconPath, {
                    maxBytes: WEBAPP_ICON_MAX_BYTES,
                    noFollow: true,
                }),
            );
        } catch (error) {
            if (error instanceof WebappIconInvalidError) {
                throw new WebappInvalidError(error.message);
            }
            throw new WebappInvalidError(
                `The webapp icon ${JSON.stringify(iconPath)} could not be read.`,
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
        throw new WebappInvalidError(
            `The webapp data directory for ${JSON.stringify(name)} already exists.`,
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
            data: { webapps: this.list() },
            id: this.#createEventId(),
            type: "webapps_changed",
        });
    }
}
