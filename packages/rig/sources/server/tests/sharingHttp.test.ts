import { request, type Server } from "node:http";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import type { SharingOutgoingContactRequest, SharingSnapshot } from "../../protocol/index.js";
import type { SharingLifecycleServiceContract } from "../../sharing/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const IDENTITY = "A".repeat(43);
const REMOTE = "B".repeat(43);
const snapshot: SharingSnapshot = {
    connection: "connected",
    contacts: [],
    folderShares: [],
    identity: IDENTITY,
    incomingRequests: [],
    outgoingRequests: [],
    profileId: null,
    version: "01900000-0000-7000-8000-000000000001",
};

describe("Sharing HTTP API", () => {
    const close: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const stop of close.splice(0).reverse()) await stop();
    });

    it("exposes invitations, contact requests, and removal", async () => {
        const sharing: SharingLifecycleServiceContract = {
            acceptContact: vi.fn(async () => undefined),
            createInvitation: vi.fn(async () => ({
                expiresAt: 301_000,
                invitation: IDENTITY,
            })),
            createFolderShare: vi.fn(async () => ({
                groupId: IDENTITY,
                members: [IDENTITY, REMOTE],
                rootFolderId: "afolder000000000000000001",
                status: "syncing" as const,
            })),
            foldersChanged: vi.fn(),
            rejectContact: vi.fn(async () => undefined),
            reset: vi.fn(async () => snapshot),
            removeContact: vi.fn(async () => undefined),
            requestContact: vi.fn(
                async (): Promise<SharingOutgoingContactRequest> => ({
                    id: IDENTITY,
                    identity: REMOTE,
                    sessionId: IDENTITY,
                }),
            ),
            snapshot: vi.fn(async () => snapshot),
        };
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), { sharing, token: "secret" }),
        );
        close.push(started.close);

        expect(await send(started.socketPath, "GET", "/sharing")).toEqual({
            body: snapshot,
            status: 200,
        });
        expect(
            await send(
                started.socketPath,
                "GET",
                "/sharing",
                undefined,
                "aprimaryinstance000000001",
            ),
        ).toEqual({
            body: { error: "Sharing is available only on the local Rig." },
            status: 403,
        });
        expect(await send(started.socketPath, "POST", "/sharing/invitations")).toEqual({
            body: { expiresAt: 301_000, invitation: IDENTITY },
            status: 201,
        });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sharing/folders",
                JSON.stringify({
                    contacts: [REMOTE],
                    folderId: "afolder000000000000000001",
                }),
            ),
        ).toEqual({
            body: {
                groupId: IDENTITY,
                members: [IDENTITY, REMOTE],
                rootFolderId: "afolder000000000000000001",
                status: "syncing",
            },
            status: 201,
        });
        expect(sharing.createFolderShare).toHaveBeenCalledWith(
            expect.anything(),
            "afolder000000000000000001",
            [REMOTE],
        );
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sharing/contact-requests",
                JSON.stringify({ invitation: IDENTITY }),
            ),
        ).toEqual({
            body: { request: { id: IDENTITY, identity: REMOTE, sessionId: IDENTITY } },
            status: 202,
        });
        expect(
            await send(started.socketPath, "POST", "/sharing/contact-requests/request-1/accept"),
        ).toMatchObject({ status: 200 });
        expect(sharing.acceptContact).toHaveBeenCalledWith(expect.anything(), "request-1");
        expect(
            await send(started.socketPath, "DELETE", "/sharing/contact-requests/request-2"),
        ).toMatchObject({ status: 200 });
        expect(sharing.rejectContact).toHaveBeenCalledWith(expect.anything(), "request-2");
        expect(
            await send(started.socketPath, "DELETE", `/sharing/contacts/${REMOTE}`),
        ).toMatchObject({ status: 200 });
        expect(sharing.removeContact).toHaveBeenCalledWith(expect.anything(), REMOTE);
        expect(await send(started.socketPath, "DELETE", "/sharing")).toEqual({
            body: snapshot,
            status: 200,
        });
        expect(sharing.reset).toHaveBeenCalledOnce();
    });

    it("rejects malformed Sharing input before calling the service", async () => {
        const sharing: SharingLifecycleServiceContract = {
            acceptContact: vi.fn(async () => undefined),
            createInvitation: vi.fn(async () => ({
                expiresAt: 1,
                invitation: IDENTITY,
            })),
            createFolderShare: vi.fn(async () => ({
                groupId: IDENTITY,
                members: [],
                rootFolderId: "afolder000000000000000001",
                status: "syncing" as const,
            })),
            foldersChanged: vi.fn(),
            rejectContact: vi.fn(async () => undefined),
            reset: vi.fn(async () => snapshot),
            removeContact: vi.fn(async () => undefined),
            requestContact: vi.fn(async () => ({
                id: IDENTITY,
                identity: REMOTE,
                sessionId: IDENTITY,
            })),
            snapshot: vi.fn(async () => snapshot),
        };
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), { sharing, token: "secret" }),
        );
        close.push(started.close);

        expect(
            await send(
                started.socketPath,
                "POST",
                "/sharing/contact-requests",
                JSON.stringify({ invitation: "short" }),
            ),
        ).toMatchObject({ status: 400 });
        expect(sharing.requestContact).not.toHaveBeenCalled();
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
    peerId?: string,
): Promise<{ body: unknown; status: number }> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body),
                              "content-type": "application/json",
                          }),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) =>
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                );
                response.once("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        body: text.length === 0 ? undefined : JSON.parse(text),
                        status: response.statusCode ?? 0,
                    });
                });
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

async function startServer(server: Server): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}
