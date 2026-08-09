import { createHash } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import {
    createEventIdFactory,
    createDocumentRequestSchema,
    documentCreatedBySchema,
    documentUnreadCursorSchema,
    DOCUMENT_STATE_MAX_BYTES,
    DOCUMENT_UPDATE_MAX_BYTES,
    listDocumentUpdatesRequestSchema,
    type CreateDocumentRequest,
    type Document,
    type DocumentCreatedBy,
    type DocumentErrorCode,
    type DocumentEvent,
    type DocumentUpdatePage,
    type ListDocumentUpdatesRequest,
    type WriteDocumentRequest,
    writeDocumentRequestSchema,
} from "../protocol/index.js";
import { documentCreate } from "../persistence/document/documentCreate.js";
import { documentWrite } from "../persistence/document/documentWrite.js";
import { queryDocument } from "../persistence/document/queryDocument.js";
import { queryDocumentUpdates } from "../persistence/document/queryDocumentUpdates.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { inTx } from "../persistence/inTx.js";
import type { TX } from "../persistence/Transaction.js";
import { clientChosenId } from "../utils/clientChosenId.js";

export class DocumentError extends Error {
    readonly code: DocumentErrorCode;

    constructor(code: DocumentErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "DocumentError";
    }
}

export interface DocumentRepositoryOptions {
    database: SessionDatabase;
    now?: () => number;
    onEvent?: (event: DocumentEvent) => void;
    transaction?: <T>(body: (tx: TX) => T) => T;
}

/** Opaque live documents whose only post-create mutation is one atomic CAS write. */
export class DocumentRepository {
    readonly #createEventId: () => string;
    readonly #database: SessionDatabase;
    readonly #now: () => number;
    readonly #onEvent: ((event: DocumentEvent) => void) | undefined;
    readonly #transaction: <T>(body: (tx: TX) => T) => T;

    constructor(options: DocumentRepositoryOptions) {
        this.#database = options.database;
        this.#now = options.now ?? Date.now;
        this.#createEventId = createEventIdFactory({ now: this.#now });
        this.#onEvent = options.onEvent;
        this.#transaction = options.transaction ?? ((body) => inTx(this.#database, body));
    }

    getDocument(documentId: string): Document | undefined {
        return queryDocument(this.#database, documentId);
    }

    createDocument(request: CreateDocumentRequest, createdBy: DocumentCreatedBy): Document {
        if (!Value.Check(createDocumentRequestSchema, request)) {
            throw new DocumentError("invalid_request", "The document request is invalid.");
        }
        if (!Value.Check(documentCreatedBySchema, createdBy)) {
            throw new DocumentError("invalid_request", "The document creator is invalid.");
        }
        const id =
            request.id === undefined
                ? createId()
                : (() => {
                      try {
                          return clientChosenId(request.id, "document");
                      } catch {
                          throw new DocumentError(
                              "invalid_request",
                              "The document ID must be a cuid2 identity.",
                          );
                      }
                  })();
        const stateJson = boundedJson(
            request.state,
            DOCUMENT_STATE_MAX_BYTES,
            "The document state is too large.",
        );
        if (
            request.unreadCursor !== undefined &&
            !Value.Check(documentUnreadCursorSchema, request.unreadCursor)
        ) {
            throw new DocumentError("invalid_request", "The unread cursor must be a UUIDv7.");
        }
        const fingerprint = hash({
            createdBy,
            id,
            identity: request.identity ?? null,
            mimeType: request.mimeType,
            state: JSON.parse(stateJson) as unknown,
            unreadCursor: request.unreadCursor ?? null,
        });
        return this.#transaction((tx) => {
            const outcome = documentCreate(tx, {
                createdBy,
                fingerprint,
                id,
                mimeType: request.mimeType,
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                now: this.#now(),
                stateJson,
                ...(request.unreadCursor === undefined
                    ? {}
                    : { unreadCursor: request.unreadCursor }),
            });
            if (outcome.outcome === "id_conflict" || outcome.outcome === "mutation_conflict") {
                throw new DocumentError(
                    "invalid_request",
                    "That document or mutation identity was already used differently.",
                );
            }
            const document = queryDocument(tx, id)!;
            if (outcome.outcome === "created") this.#publish(document, request.mutationId);
            return document;
        });
    }

    writeDocument(
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Document | undefined {
        if (!Value.Check(writeDocumentRequestSchema, request)) {
            throw new DocumentError("invalid_request", "The document write is invalid.");
        }
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
            throw new DocumentError("invalid_request", "The expected version is invalid.");
        }
        if (
            request.unreadCursor !== undefined &&
            request.unreadCursor !== null &&
            !Value.Check(documentUnreadCursorSchema, request.unreadCursor)
        ) {
            throw new DocumentError("invalid_request", "The unread cursor must be a UUIDv7.");
        }
        const stateJson = boundedJson(
            request.state,
            DOCUMENT_STATE_MAX_BYTES,
            "The document state is too large.",
        );
        const updateJson = boundedJson(
            request.update,
            DOCUMENT_UPDATE_MAX_BYTES,
            "The document update is too large.",
        );
        const fingerprint = hash({
            documentId,
            expectedVersion,
            mimeType: request.mimeType ?? null,
            state: JSON.parse(stateJson) as unknown,
            unreadCursor: request.unreadCursor === undefined ? "omitted" : request.unreadCursor,
            update: JSON.parse(updateJson) as unknown,
        });
        return this.#transaction((tx) => {
            const outcome = documentWrite(tx, {
                expectedVersion,
                fingerprint,
                id: documentId,
                ...(request.mimeType === undefined ? {} : { mimeType: request.mimeType }),
                ...(request.mutationId === undefined ? {} : { mutationId: request.mutationId }),
                now: this.#now(),
                stateJson,
                ...(request.unreadCursor === undefined
                    ? {}
                    : { unreadCursor: request.unreadCursor }),
                updateBytes: Buffer.byteLength(updateJson),
                updateId: this.#createEventId(),
                updateJson,
            });
            if (outcome.outcome === "document_not_found") return undefined;
            if (outcome.outcome === "version_conflict") {
                throw new DocumentError(
                    "version_conflict",
                    "The document changed before it could be written.",
                );
            }
            if (outcome.outcome === "mutation_conflict") {
                throw new DocumentError(
                    "invalid_request",
                    "That mutation ID was already used for a different document write.",
                );
            }
            const document = queryDocument(tx, documentId);
            if (outcome.outcome === "written" && document !== undefined) {
                this.#publish(document, request.mutationId);
            }
            return document;
        });
    }

    documentUpdates(
        documentId: string,
        request: ListDocumentUpdatesRequest,
    ): DocumentUpdatePage | undefined {
        if (!Value.Check(listDocumentUpdatesRequestSchema, request)) {
            throw new DocumentError("invalid_request", "The document update page is invalid.");
        }
        return queryDocumentUpdates(
            this.#database,
            documentId,
            request.afterVersion,
            request.limit ?? 100,
        );
    }

    #publish(document: Document, mutationId: string | undefined): void {
        this.#onEvent?.({
            createdAt: this.#now(),
            data: {
                documentId: document.id,
                ...(mutationId === undefined ? {} : { mutationId }),
                version: document.version,
            },
            id: this.#createEventId(),
            type: "document_changed",
        });
    }
}

function boundedJson(value: unknown, maximum: number, message: string): string {
    let json: string;
    try {
        json = canonicalJson(value);
    } catch {
        throw new DocumentError("invalid_request", "The document value must be valid JSON.");
    }
    if (Buffer.byteLength(json) > maximum) {
        throw new DocumentError("invalid_request", message);
    }
    return json;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(",")}}`;
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("not JSON");
    return json;
}

function hash(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
