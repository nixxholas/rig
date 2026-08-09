import { request, type Server } from "node:http";
import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OnboardingService } from "../../onboarding/OnboardingService.js";
import { RigProfileStore } from "../../profiles/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const LOCAL_INSTANCE_ID = "alocalinstance00000000001";

describe("onboarding daemon wiring", () => {
    it("advances through provider setup and profile creation over the real HTTP surface", async () => {
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            localInstanceId: LOCAL_INSTANCE_ID,
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: LOCAL_INSTANCE_ID,
            publish: (event) => {
                store.globalEventQueue.publishLive(event);
                store.liveEvents.publish(event);
            },
        });
        let providersConfigured = false;
        let murmurConfigured = false;
        const onboarding = new OnboardingService({
            murmurConfigured: () => murmurConfigured,
            onboardMurmur: async (request) => {
                murmurConfigured = true;
                return request.enabled
                    ? Promise.reject(new Error("This fixture only exercises opt-out."))
                    : { enabled: false };
            },
            persistence: store,
            profileComplete: () =>
                profiles.list().some((profile) => profile.parentInstanceId === LOCAL_INSTANCE_ID),
            providersConfigured: () => providersConfigured,
        });
        const started = await startServer(
            createProtocolHttpServer({
                onboarding,
                profiles,
                store,
                token: "secret",
            }),
        );
        try {
            await expect(send(started.socketPath, "GET", "/onboarding")).resolves.toMatchObject({
                body: { state: "provider_setup" },
                status: 200,
            });

            providersConfigured = true;
            await expect(send(started.socketPath, "GET", "/onboarding")).resolves.toMatchObject({
                body: { state: "profile_required" },
                status: 200,
            });

            await expect(
                send(started.socketPath, "POST", "/profiles", {
                    email: "steve@example.com",
                    name: "Steve",
                }),
            ).resolves.toMatchObject({
                body: { profile: { name: "Steve", parentInstanceId: LOCAL_INSTANCE_ID } },
                status: 201,
            });
            await expect(send(started.socketPath, "GET", "/onboarding")).resolves.toMatchObject({
                body: { state: "murmur_setup" },
                status: 200,
            });
            await expect(
                send(started.socketPath, "PUT", "/onboarding/murmur", { enabled: false }),
            ).resolves.toMatchObject({
                body: { enabled: false },
                status: 200,
            });
            await expect(send(started.socketPath, "GET", "/onboarding")).resolves.toMatchObject({
                body: { onboardingVersion: 2, state: "complete" },
                status: 200,
            });
        } finally {
            await started.close();
            store.close();
        }
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ body: unknown; status: number }> {
    return await new Promise((resolve, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(encoded === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(encoded),
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
        outgoing.end(encoded);
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
