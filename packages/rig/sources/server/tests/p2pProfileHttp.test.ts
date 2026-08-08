import { request, type Server } from "node:http";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { RigProfileStore } from "../../profiles/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const PRIMARY_ID = "aprimaryinstance000000001";
const SECONDARY_ID = "asecondaryinstance0000001";
const OTHER_ID = "aotherpeerinstance00000001";
const PROFILE_ID = "aprofile000000000000000004";

describe("P2P human profiles", () => {
    const close: (() => Promise<void>)[] = [];

    afterEach(async () => {
        await Promise.all(close.splice(0).map((stop) => stop()));
    });

    it("accepts replicas only from the active primary and requires them on remote messages", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: SECONDARY_ID,
            publish: () => undefined,
        });
        const localProfile = profiles.create({ name: "Secondary operator" });
        const session = store.create(
            { cwd: "/tmp/p2p-profile-secondary" },
            { ownerInstanceId: PRIMARY_ID },
        );
        const started = await startServer(
            createProtocolHttpServer({
                canP2pPeerConfigure: (peerId) => peerId === PRIMARY_ID,
                p2pNode: () => ({
                    name: "Secondary",
                    primaryId: PRIMARY_ID,
                    role: "secondary",
                }),
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            store.close();
        });
        const profile = {
            createdAt: 1_000,
            id: PROFILE_ID,
            name: "Steve",
            parentInstanceId: PRIMARY_ID,
            updatedAt: 1_000,
            version: 1,
        };
        const replicaBody = JSON.stringify({ profile });

        expect(
            await send(started.socketPath, "PUT", `/profiles/${PROFILE_ID}`, replicaBody, OTHER_ID),
        ).toMatchObject({ status: 403 });
        expect(
            await send(
                started.socketPath,
                "PUT",
                `/profiles/${PROFILE_ID}`,
                replicaBody,
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: { profile },
            status: 200,
        });
        expect(
            await send(started.socketPath, "GET", `/profiles/${PROFILE_ID}`, undefined, PRIMARY_ID),
        ).toMatchObject({ body: { profile }, status: 200 });
        expect(await send(started.socketPath, "GET", "/profiles", undefined, PRIMARY_ID)).toEqual({
            body: { profiles: [profile] },
            status: 200,
        });
        expect(
            await send(
                started.socketPath,
                "GET",
                `/profiles/${localProfile.id}`,
                undefined,
                PRIMARY_ID,
            ),
        ).toMatchObject({ status: 404 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ text: "Missing profile" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_required" }, status: 400 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({
                    identity: "aunknownprofile000000000001",
                    text: "Wrong profile",
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_not_owned" }, status: 403 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ identity: PROFILE_ID, text: "Attributed message" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ status: 202 });
        expect(
            session.events
                .since(undefined)
                ?.findLast((event) => event.type === "message_submitted"),
        ).toMatchObject({ data: { message: { identity: PROFILE_ID } } });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ identity: PROFILE_ID, text: "Local impersonation" }),
            ),
        ).toMatchObject({ body: { code: "profile_not_owned" }, status: 403 });
        void session.abort();
    });

    it("creates named profiles only on a local primary", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: PRIMARY_ID,
            publish: () => undefined,
        });
        const started = await startServer(
            createProtocolHttpServer({
                p2pNode: () => ({ name: "Primary", role: "primary" }),
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            store.close();
        });

        const created = await send(
            started.socketPath,
            "POST",
            "/profiles",
            JSON.stringify({ name: "Steve Korshakov 🧑‍💻" }),
        );
        expect(created).toMatchObject({
            body: {
                profile: {
                    id: expect.any(String),
                    name: "Steve Korshakov 🧑‍💻",
                    parentInstanceId: PRIMARY_ID,
                    version: 1,
                },
            },
            status: 201,
        });
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
    peerId?: string,
): Promise<{ body: unknown; status: number }> {
    return await new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body),
                              "content-type": "application/json",
                          }),
                    ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
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
