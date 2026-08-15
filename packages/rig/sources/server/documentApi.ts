import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { DocumentError, type DocumentRepository } from "../documents/DocumentRepository.js";
import {
    createDocumentRequestSchema,
    DOCUMENT_STATE_MAX_BYTES,
    DOCUMENT_UPDATE_MAX_BYTES,
    type DocumentCreatedBy,
    type DocumentErrorCode,
    type DocumentErrorResponse,
    type DocumentResponse,
    type DocumentUpdatePage,
    writeDocumentRequestSchema,
} from "../protocol/index.js";
import { sendJson } from "./sendJson.js";

export interface DocumentRoute {
    documentId?: string;
    name: "documents" | "document" | "document-updates" | "document-write";
}

export async function serveDocumentRequest(
    ctx: Context,
    store: Pick<
        DocumentRepository,
        "createDocument" | "documentUpdates" | "getDocument" | "writeDocument"
    >,
    route: DocumentRoute,
    request: Pick<IncomingMessage, "headers" | "method">,
    response: ServerResponse,
    searchParams: URLSearchParams,
    readJson: (limitBytes: number) => Promise<unknown>,
    resolveCreatedBy: (
        identity: string | null | undefined,
    ) => Promise<DocumentCreatedBy | undefined>,
): Promise<void> {
    try {
        if (route.name === "documents") {
            if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const body = await readJson(DOCUMENT_STATE_MAX_BYTES * 2 + 64 * 1024);
            if (!Value.Check(createDocumentRequestSchema, body)) {
                sendDocumentError(
                    response,
                    400,
                    "invalid_request",
                    "A document needs a MIME type and current state.",
                );
                return;
            }
            const mutationId = requestMutationId(request);
            if (!matchingMutationIds(body.mutationId, mutationId)) {
                sendDocumentError(
                    response,
                    400,
                    "invalid_request",
                    "The mutation ID did not match.",
                );
                return;
            }
            const createdBy = await resolveCreatedBy(body.identity);
            if (createdBy === undefined) return;
            const document = await store.createDocument(
                ctx,
                { ...body, ...(mutationId === undefined ? {} : { mutationId }) },
                createdBy,
            );
            sendJson<DocumentResponse>(response, 201, { document });
            return;
        }

        const documentId = route.documentId;
        if (documentId === undefined) {
            sendDocumentError(response, 400, "invalid_request", "A document is required.");
            return;
        }
        if (route.name === "document") {
            if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const document = await store.getDocument(ctx, documentId);
            if (document === undefined) {
                sendDocumentError(
                    response,
                    404,
                    "document_not_found",
                    "That document was not found.",
                );
                return;
            }
            sendJson<DocumentResponse>(response, 200, { document });
            return;
        }
        if (route.name === "document-updates") {
            if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const rawAfterVersion = searchParams.get("afterVersion");
            const afterVersion =
                rawAfterVersion === null ? 0 : parseNonNegativeInteger(rawAfterVersion);
            if (afterVersion === undefined) {
                sendDocumentError(
                    response,
                    400,
                    "invalid_request",
                    "The document update cursor is invalid.",
                );
                return;
            }
            const rawLimit = searchParams.get("limit");
            const limit = rawLimit === null ? undefined : parsePositiveInteger(rawLimit);
            if (rawLimit !== null && limit === undefined) {
                sendDocumentError(
                    response,
                    400,
                    "invalid_request",
                    "The document update limit is invalid.",
                );
                return;
            }
            const page = await store.documentUpdates(ctx, documentId, {
                afterVersion,
                ...(limit === undefined ? {} : { limit }),
            });
            if (page === undefined) {
                sendDocumentError(
                    response,
                    404,
                    "document_not_found",
                    "That document was not found.",
                );
                return;
            }
            sendJson<DocumentUpdatePage>(response, 200, page);
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendDocumentError(
                response,
                428,
                "invalid_request",
                "Writing a document needs its current version.",
            );
            return;
        }
        const body = await readJson(
            DOCUMENT_STATE_MAX_BYTES * 2 + DOCUMENT_UPDATE_MAX_BYTES * 2 + 64 * 1024,
        );
        if (!Value.Check(writeDocumentRequestSchema, body)) {
            sendDocumentError(
                response,
                400,
                "invalid_request",
                "A document write needs the next state and one opaque update.",
            );
            return;
        }
        const mutationId = requestMutationId(request);
        if (!matchingMutationIds(body.mutationId, mutationId)) {
            sendDocumentError(response, 400, "invalid_request", "The mutation ID did not match.");
            return;
        }
        const document = await store.writeDocument(
            ctx,
            documentId,
            { ...body, ...(mutationId === undefined ? {} : { mutationId }) },
            expectedVersion,
        );
        if (document === undefined) {
            sendDocumentError(response, 404, "document_not_found", "That document was not found.");
            return;
        }
        sendJson<DocumentResponse>(response, 200, { document });
    } catch (error) {
        if (!(error instanceof DocumentError)) throw error;
        if (error.code === "version_conflict" && route.documentId !== undefined) {
            const current = await store.getDocument(ctx, route.documentId);
            if (current !== undefined) {
                sendJson<DocumentResponse>(response, 409, { document: current });
                return;
            }
        }
        sendDocumentError(response, statusForCode(error.code), error.code, error.message);
    }
}

function parseEntityVersion(value: string | readonly string[] | undefined): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined) return undefined;
    const match = /^(?:"(0|[1-9]\d*)"|(0|[1-9]\d*))$/.exec(raw);
    if (match === null) return undefined;
    const version = Number(match[1] ?? match[2]);
    return Number.isSafeInteger(version) ? version : undefined;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
    if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePositiveInteger(value: string): number | undefined {
    const parsed = parseNonNegativeInteger(value);
    return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function requestMutationId(request: Pick<IncomingMessage, "headers">): string | undefined {
    const value = request.headers["x-rig-mutation-id"];
    return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function matchingMutationIds(body: string | undefined, header: string | undefined): boolean {
    return body === undefined || header === undefined || body === header;
}

function statusForCode(code: DocumentErrorCode): number {
    switch (code) {
        case "document_not_found":
            return 404;
        case "invalid_request":
            return 400;
        case "version_conflict":
            return 409;
    }
}

function sendDocumentError(
    response: ServerResponse,
    status: number,
    code: DocumentErrorCode,
    message: string,
): void {
    sendJson<DocumentErrorResponse>(response, status, { error: { code, message } });
}
