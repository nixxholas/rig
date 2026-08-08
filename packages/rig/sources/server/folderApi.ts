import type { ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

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
    store: SessionStore,
    route: FolderRoute,
    request: { method?: string | undefined },
    response: ServerResponse,
    readJson: (limitBytes: number) => Promise<unknown>,
): Promise<void> {
    try {
        if (route.name === "folders") {
            if (request.method === "GET") {
                sendJson<ListFoldersResponse>(response, 200, { folders: store.listFolders() });
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
            sendJson<FolderResponse>(response, 201, { folder: store.createFolder(body) });
            return;
        }
        const folderId = route.folderId;
        if (folderId === undefined) {
            sendFolderError(response, 400, "invalid_request", "A folder is required.");
            return;
        }
        if (route.name === "folder") {
            if (request.method === "GET") {
                const folder = store.getFolder(folderId);
                if (folder === undefined) {
                    sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
                    return;
                }
                sendJson<FolderResponse>(response, 200, { folder });
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
            const folder = store.updateFolder(folderId, body);
            if (folder === undefined) {
                sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
                return;
            }
            sendJson<FolderResponse>(response, 200, { folder });
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (route.name === "folder-archive") {
            const folder = store.archiveFolder(folderId);
            if (folder === undefined) {
                sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
                return;
            }
            sendJson<FolderResponse>(response, 200, { folder });
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
        const folder = store.moveFolder(folderId, body);
        if (folder === undefined) {
            sendFolderError(response, 404, "folder_not_found", "That folder is gone.");
            return;
        }
        sendJson<FolderResponse>(response, 200, { folder });
    } catch (error) {
        if (error instanceof FolderError) {
            sendFolderError(response, statusForCode(error.code), error.code, error.message);
            return;
        }
        throw error;
    }
}

function statusForCode(code: FolderErrorCode): number {
    switch (code) {
        case "folder_not_found":
        case "parent_not_found":
        case "sibling_not_found":
            return 404;
        case "cycle":
        case "invalid_request":
            return 400;
        case "storage_unavailable":
            return 500;
    }
}

function sendFolderError(
    response: ServerResponse,
    status: number,
    code: FolderErrorCode,
    message: string,
): void {
    sendJson<FolderErrorResponse>(response, status, { error: { code, message } });
}
