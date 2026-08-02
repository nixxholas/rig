import { randomUUID } from "node:crypto";

import type { Attachment } from "./attachmentSchemas.js";

/**
 * Pending attachment intent for one agent run.
 *
 * The agent loop takes this list only after a normal terminal response and
 * discards it on every incomplete end state.
 */
export class AttachmentContext {
    readonly #attachmentsById = new Map<string, Attachment>();
    readonly #attachmentsBySource = new Map<string, Attachment>();
    readonly #preparingBySource = new Map<string, Promise<Attachment>>();
    readonly #cleanupById = new Map<string, () => void | Promise<void>>();
    readonly #idFactory: () => string;
    #generation = 0;

    constructor(options: { idFactory?: () => string } = {}) {
        this.#idFactory = options.idFactory ?? randomUUID;
    }

    async add(source: string, prepare: (id: string) => Promise<Attachment>): Promise<Attachment> {
        const existing = this.#attachmentsBySource.get(source);
        if (existing !== undefined) return existing;
        const preparing = this.#preparingBySource.get(source);
        if (preparing !== undefined) return preparing;

        const generation = this.#generation;
        const operation = (async () => {
            const id = this.#idFactory();
            const attachment = await prepare(id);
            if (this.#generation !== generation) {
                this.#runCleanup(id);
                return attachment;
            }
            this.#attachmentsById.set(attachment.id, attachment);
            this.#attachmentsBySource.set(source, attachment);
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
        this.#attachmentsBySource.delete(attachment.source);
        this.#runCleanup(id);
        return true;
    }

    registerCleanup(id: string, cleanup: () => void | Promise<void>): void {
        this.#cleanupById.set(id, cleanup);
    }

    pending(): readonly Attachment[] {
        return [...this.#attachmentsById.values()];
    }

    takePending(): readonly Attachment[] {
        const attachments = this.pending();
        this.#generation += 1;
        this.#attachmentsById.clear();
        this.#attachmentsBySource.clear();
        this.#preparingBySource.clear();
        this.#cleanupById.clear();
        return attachments;
    }

    discard(): void {
        this.#generation += 1;
        for (const id of this.#cleanupById.keys()) this.#runCleanup(id);
        this.#attachmentsById.clear();
        this.#attachmentsBySource.clear();
        this.#preparingBySource.clear();
    }

    #runCleanup(id: string): void {
        const cleanup = this.#cleanupById.get(id);
        this.#cleanupById.delete(id);
        if (cleanup !== undefined) void Promise.resolve(cleanup()).catch(() => undefined);
    }
}
