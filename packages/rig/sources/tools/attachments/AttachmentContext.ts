import { randomUUID } from "node:crypto";

import type { Attachment } from "./attachmentSchemas.js";

export interface AttachmentScope {
    projectId: string;
    sessionId: string;
    workspaceId?: string;
}

/**
 * Pending attachment intent for one agent run.
 *
 * The agent loop takes this list only after a normal terminal response and
 * discards it on every incomplete end state.
 */
export class AttachmentContext {
    readonly #attachmentsById = new Map<string, Attachment>();
    readonly #attachmentsBySource = new Map<string, Attachment>();
    readonly #sourceById = new Map<string, string>();
    readonly #preparingBySource = new Map<string, Promise<Attachment>>();
    readonly #cleanupById = new Map<string, (() => void | Promise<void>)[]>();
    readonly #idFactory: () => string;
    #generation = 0;

    readonly #scope: AttachmentScope | undefined;

    constructor(options: { idFactory?: () => string; scope?: AttachmentScope } = {}) {
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#scope = options.scope;
    }

    async add(source: string, prepare: (id: string) => Promise<Attachment>): Promise<Attachment> {
        const existing = this.#attachmentsBySource.get(source);
        if (existing !== undefined) return existing;
        const preparing = this.#preparingBySource.get(source);
        if (preparing !== undefined) return preparing;

        const generation = this.#generation;
        const operation = (async () => {
            const id = this.#idFactory();
            let attachment;
            try {
                attachment = await prepare(id);
            } catch (error) {
                this.#runCleanup(id);
                throw error;
            }
            if (this.#generation !== generation) {
                this.#runCleanup(id);
                return attachment;
            }
            this.#attachmentsById.set(attachment.id, attachment);
            this.#attachmentsBySource.set(source, attachment);
            this.#sourceById.set(attachment.id, source);
            return attachment;
        })();
        this.#preparingBySource.set(source, operation);
        try {
            return await operation;
        } finally {
            if (this.#preparingBySource.get(source) === operation) {
                this.#preparingBySource.delete(source);
            }
        }
    }

    remove(id: string): boolean {
        const attachment = this.#attachmentsById.get(id);
        if (attachment === undefined) return false;
        this.#attachmentsById.delete(id);
        const source = this.#sourceById.get(id);
        if (source !== undefined) this.#attachmentsBySource.delete(source);
        this.#sourceById.delete(id);
        this.#runCleanup(id);
        return true;
    }

    registerCleanup(id: string, cleanup: () => void | Promise<void>): void {
        const cleanups = this.#cleanupById.get(id) ?? [];
        cleanups.push(cleanup);
        this.#cleanupById.set(id, cleanups);
    }

    pending(): readonly Attachment[] {
        return [...this.#attachmentsById.values()];
    }

    scope(): AttachmentScope | undefined {
        return this.#scope;
    }

    takePending(): readonly Attachment[] {
        const attachments = this.pending();
        this.#generation += 1;
        this.#attachmentsById.clear();
        this.#attachmentsBySource.clear();
        this.#sourceById.clear();
        this.#preparingBySource.clear();
        this.#cleanupById.clear();
        return attachments;
    }

    discard(): void {
        this.#generation += 1;
        for (const id of this.#cleanupById.keys()) this.#runCleanup(id);
        this.#attachmentsById.clear();
        this.#attachmentsBySource.clear();
        this.#sourceById.clear();
        this.#preparingBySource.clear();
    }

    #runCleanup(id: string): void {
        const cleanups = this.#cleanupById.get(id);
        this.#cleanupById.delete(id);
        for (const cleanup of cleanups ?? []) {
            void Promise.resolve(cleanup()).catch(() => undefined);
        }
    }
}
