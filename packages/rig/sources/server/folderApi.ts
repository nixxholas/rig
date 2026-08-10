import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { FolderError } from "../folders/FolderRepository.js";
import {
    createFolderRequestSchema,
    moveFolderRequestSchema,
    updateFolderRequestSchema,
    type FolderErrorCode,
    type FolderErrorResponse,
    type FolderResponse,
    type ListFoldersResponse,
} from "../protocol/index.js";
import { sendJson } from "./sendJson.js";
import type { SessionStore } from "../session/SessionStore.js";

/** One route in the folder surface, already parsed out of the URL. */
export interface FolderRoute {
    /** Present for every route but the collection itself. */
    folderId?: string;
    name: "folder" | "folder-archive" | "folder-move" | "folders";
}

/**
 * The folder tree over HTTP.
 *
 * Folders carry no Git state, so unlike projects there is nothing here about branches, comparisons,
 * or changed files: a folder is a name, some rules, an icon, a place in the tree, and a directory.
 */
export async function serveFolderRequest(
    ctx: Context,
    store: SessionStore,
    route: FolderRoute,
    request: Pick<IncomingMessage, "headers" | "method">,
    response: ServerResponse,
    readJson: (limitBytes: number) => Promise<unknown>,
): Promise<void> {
    try {
        if (route.name === "folders") {
            if (request.method === "GET") {
                sendJson<ListFoldersResponse>(response, 200, await store.folderCatalog(ctx));
                return;
            }
            if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const body = await readJson(64 * 1024);
            if (!Value.Check(createFolderRequestSchema, body)) {
                sendFolderError(response, 400, "invalid_request", "A folder name is required.");
                return;
            }
            const mutationId = requestMutationId(request);
            if (!matchingMutationIds(body.mutationId, mutationId)) {
                sendFolderError(response, 400, "invalid_request", "The mutation ID did not match.");
                return;
            }
            const created = await store.createFolder(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            sendJson<FolderResponse>(
                response,
                201,
                await folderResponse(ctx, store, created.id, created),
            );
            return;
        }
        const folderId = route.folderId;
        if (folderId === undefined) {
            sendFolderError(response, 400, "invalid_request", "A folder is required.");
            return;
        }
        if (route.name === "folder") {
            if (request.method === "GET") {
                const folder = await store.getFolder(ctx, folderId);
                if (folder === undefined) {
                    sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
                    return;
                }
                sendJson<FolderResponse>(
                    response,
                    200,
                    await folderResponse(ctx, store, folderId, folder),
                );
                return;
            }
            if (request.method !== "PATCH") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const body = await readJson(64 * 1024);
            if (!Value.Check(updateFolderRequestSchema, body)) {
                sendFolderError(
                    response,
                    400,
                    "invalid_request",
                    "A folder change must only set a name, description, rules, or icon.",
                );
                return;
            }
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendFolderError(
                    response,
                    428,
                    "invalid_request",
                    "A folder update needs its current version.",
                );
                return;
            }
            const mutationId = requestMutationId(request);
            if (!matchingMutationIds(body.mutationId, mutationId)) {
                sendFolderError(response, 400, "invalid_request", "The mutation ID did not match.");
                return;
            }
            const folder = await store.updateFolder(
                ctx,
                folderId,
                { ...body, ...(mutationId === undefined ? {} : { mutationId }) },
                expectedVersion,
            );
            if (folder === undefined) {
                sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
                return;
            }
            sendJson<FolderResponse>(
                response,
                200,
                await folderResponse(ctx, store, folderId, folder),
            );
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (route.name === "folder-archive") {
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendFolderError(
                    response,
                    428,
                    "invalid_request",
                    "Archiving a folder needs its current version.",
                );
                return;
            }
            const folder = await store.archiveFolder(
                ctx,
                folderId,
                expectedVersion,
                requestMutationId(request),
            );
            if (folder === undefined) {
                sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
                return;
            }
            sendJson<FolderResponse>(
                response,
                200,
                await folderResponse(ctx, store, folderId, folder),
            );
            return;
        }
        const body = await readJson(8 * 1024);
        if (!Value.Check(moveFolderRequestSchema, body)) {
            sendFolderError(
                response,
                400,
                "invalid_request",
                "A move needs the folder it lands in and the sibling it lands below.",
            );
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendFolderError(
                response,
                428,
                "invalid_request",
                "Moving a folder needs its current version.",
            );
            return;
        }
        const mutationId = requestMutationId(request);
        if (!matchingMutationIds(body.mutationId, mutationId)) {
            sendFolderError(response, 400, "invalid_request", "The mutation ID did not match.");
            return;
        }
        const folder = await store.moveFolder(
            ctx,
            folderId,
            { ...body, ...(mutationId === undefined ? {} : { mutationId }) },
            expectedVersion,
        );
        if (folder === undefined) {
            sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
            return;
        }
        sendJson<FolderResponse>(response, 200, await folderResponse(ctx, store, folderId, folder));
    } catch (error) {
        if (error instanceof FolderError) {
            if (error.code === "version_conflict" && route.folderId !== undefined) {
                const current = await store.getFolder(ctx, route.folderId);
                if (current !== undefined) {
                    sendJson<FolderResponse>(
                        response,
                        409,
                        await folderResponse(ctx, store, route.folderId, current),
                    );
                    return;
                }
            }
            sendFolderError(response, statusForCode(error.code), error.code, error.message);
            return;
        }
        throw error;
    }
}

function statusForCode(code: FolderErrorCode): number {
    switch (code) {
        case "folder_not_found":
        case "item_not_found":
        case "parent_not_found":
        case "sibling_not_found":
        case "target_not_found":
            return 404;
        case "cycle":
        case "invalid_request":
        case "shared_folder_boundary":
        case "shared_folder_contents_forbidden":
            return 400;
        case "version_conflict":
            return 409;
        case "storage_unavailable":
            return 500;
    }
}

async function folderResponse(
    ctx: Context,
    store: SessionStore,
    folderId: string,
    fallback: FolderResponse["folder"],
): Promise<FolderResponse> {
    const catalog = await store.folderCatalog(ctx);
    return {
        folder: catalog.folders.find((folder) => folder.id === folderId) ?? fallback,
        revision: catalog.revision,
    };
}

function requestMutationId(request: Pick<IncomingMessage, "headers">): string | undefined {
    const value = request.headers["x-rig-mutation-id"];
    return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function matchingMutationIds(body: string | undefined, header: string | undefined): boolean {
    return body === undefined || header === undefined || body === header;
}

function parseEntityVersion(value: string | readonly string[] | undefined): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined) return undefined;
    const match = /^(?:"(0|[1-9]\d*)"|(0|[1-9]\d*))$/.exec(raw);
    if (match === null) return undefined;
    const version = Number(match[1] ?? match[2]);
    return Number.isSafeInteger(version) ? version : undefined;
}

function sendFolderError(
    response: ServerResponse,
    status: number,
    code: FolderErrorCode,
    message: string,
): void {
    sendJson<FolderErrorResponse>(response, status, { error: { code, message } });
}
