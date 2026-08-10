import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { FolderError } from "../folders/FolderRepository.js";
import {
    createFolderItemRequestSchema,
    moveFolderItemRequestSchema,
    type FolderErrorCode,
    type FolderErrorResponse,
    type FolderItemResponse,
} from "../protocol/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import { sendJson } from "./sendJson.js";

export interface FolderItemRoute {
    folderId?: string;
    itemId?: string;
    name: "folder-items" | "folder-item" | "folder-item-archive" | "folder-item-move";
}

export async function serveFolderItemRequest(
    ctx: Context,
    store: SessionStore,
    route: FolderItemRoute,
    request: Pick<IncomingMessage, "headers" | "method">,
    response: ServerResponse,
    readJson: (limitBytes: number) => Promise<unknown>,
): Promise<void> {
    try {
        if (route.name === "folder-items") {
            if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            if (route.folderId === undefined) {
                sendFolderItemError(response, 400, "invalid_request", "A folder is required.");
                return;
            }
            const body = await readJson(64 * 1024);
            if (!Value.Check(createFolderItemRequestSchema, body)) {
                sendFolderItemError(
                    response,
                    400,
                    "invalid_request",
                    "A folder item needs a project, workspace, or document target.",
                );
                return;
            }
            const mutationId = requestMutationId(request);
            if (!matchingMutationIds(body.mutationId, mutationId)) {
                sendFolderItemError(
                    response,
                    400,
                    "invalid_request",
                    "The mutation ID did not match.",
                );
                return;
            }
            const item = await store.createFolderItem(ctx, route.folderId, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            sendJson<FolderItemResponse>(
                response,
                201,
                await itemResponse(ctx, store, item.id, item),
            );
            return;
        }

        const itemId = route.itemId;
        if (itemId === undefined) {
            sendFolderItemError(response, 400, "invalid_request", "A folder item is required.");
            return;
        }
        if (route.name === "folder-item") {
            if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const item = await store.getFolderItem(ctx, itemId);
            if (item === undefined) {
                sendFolderItemError(
                    response,
                    404,
                    "item_not_found",
                    "That folder item was not found.",
                );
                return;
            }
            sendJson<FolderItemResponse>(
                response,
                200,
                await itemResponse(ctx, store, itemId, item),
            );
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendFolderItemError(
                response,
                428,
                "invalid_request",
                route.name === "folder-item-move"
                    ? "Moving a folder item needs its current version."
                    : "Removing a folder item needs its current version.",
            );
            return;
        }
        const mutationId = requestMutationId(request);
        if (route.name === "folder-item-archive") {
            const item = await store.archiveFolderItem(ctx, itemId, expectedVersion, mutationId);
            if (item === undefined) {
                sendFolderItemError(
                    response,
                    404,
                    "item_not_found",
                    "That folder item was not found.",
                );
                return;
            }
            sendJson<FolderItemResponse>(
                response,
                200,
                await itemResponse(ctx, store, itemId, item),
            );
            return;
        }
        const body = await readJson(16 * 1024);
        if (!Value.Check(moveFolderItemRequestSchema, body)) {
            sendFolderItemError(
                response,
                400,
                "invalid_request",
                "A move needs its destination folder and preceding item.",
            );
            return;
        }
        if (!matchingMutationIds(body.mutationId, mutationId)) {
            sendFolderItemError(response, 400, "invalid_request", "The mutation ID did not match.");
            return;
        }
        const item = await store.moveFolderItem(
            ctx,
            itemId,
            { ...body, ...(mutationId === undefined ? {} : { mutationId }) },
            expectedVersion,
        );
        if (item === undefined) {
            sendFolderItemError(response, 404, "item_not_found", "That folder item was not found.");
            return;
        }
        sendJson<FolderItemResponse>(response, 200, await itemResponse(ctx, store, itemId, item));
    } catch (error) {
        if (!(error instanceof FolderError)) throw error;
        if (error.code === "version_conflict" && route.itemId !== undefined) {
            const current = await store.getFolderItem(ctx, route.itemId);
            if (current !== undefined) {
                sendJson<FolderItemResponse>(
                    response,
                    409,
                    await itemResponse(ctx, store, route.itemId, current),
                );
                return;
            }
        }
        sendFolderItemError(response, statusForCode(error.code), error.code, error.message);
    }
}

async function itemResponse(
    ctx: Context,
    store: SessionStore,
    itemId: string,
    fallback: FolderItemResponse["item"],
): Promise<FolderItemResponse> {
    const catalog = await store.folderCatalog(ctx);
    return {
        item: catalog.items.find((item) => item.id === itemId) ?? fallback,
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

function sendFolderItemError(
    response: ServerResponse,
    status: number,
    code: FolderErrorCode,
    message: string,
): void {
    sendJson<FolderErrorResponse>(response, status, { error: { code, message } });
}
