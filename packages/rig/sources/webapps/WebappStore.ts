import { cp, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Value } from "@sinclair/typebox/value";

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
import { WebappInvalidError } from "./WebappInvalidError.js";
import { WebappNotFoundError } from "./WebappNotFoundError.js";

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

    constructor(options: WebappStoreOptions) {
        this.#environment = options.environment ?? process.env;
        this.#now = options.now ?? Date.now;
        this.#publish = options.publish;
        this.#tx = options.tx;
    }

    async create(request: CreateWebappRequest): Promise<Webapp> {
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
        await this.#importVersion(request.name, 1, request.path);
        const created = inTx(this.#tx(), (tx) => {
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
                name: request.name,
                purpose: request.purpose,
                ...(request.sourceDescription === undefined
                    ? {}
                    : { sourceDescription: request.sourceDescription }),
            });
            return queryWebapp(tx, request.name);
        });
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

    async update(name: string, request: UpdateWebappRequest): Promise<Webapp> {
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
        await this.#importVersion(name, nextVersion, request.path);
        const updated = inTx(this.#tx(), (tx) => {
            webappAddVersion(tx, name, nextVersion, request.changeDescription, this.#now());
            return queryWebapp(tx, name);
        });
        this.#publishChanged();
        if (updated === undefined) throw new Error("The webapp was not stored.");
        return updated;
    }

    async #importVersion(name: string, version: number, sourcePath: string): Promise<void> {
        if (!isAbsolute(sourcePath)) {
            throw new WebappInvalidError(
                "The webapp source path must be an absolute folder path on this machine.",
            );
        }
        let facts;
        try {
            facts = await stat(sourcePath);
        } catch {
            throw new WebappInvalidError(
                `The webapp source folder ${JSON.stringify(sourcePath)} does not exist.`,
            );
        }
        if (!facts.isDirectory()) {
            throw new WebappInvalidError(
                `The webapp source ${JSON.stringify(sourcePath)} is not a folder.`,
            );
        }
        const target = join(getWebappsDirectory(this.#environment), name, `v${String(version)}`);
        await cp(sourcePath, target, { recursive: true });
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
