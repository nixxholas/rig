import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import {
    HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH,
    HAPPY_CLOUD_CONTRACT_VERSION,
    type HappyCloudCommand,
} from "../../protocol/index.js";
import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Happy Cloud HTTP API", () => {
    it("authenticates, validates, and round-trips the strict persisted contract", async () => {
        const fixture = await startServer();
        try {
            await expect(fixture.client.getHappyCloudStatus()).resolves.toMatchObject({
                enrollment: { state: "not_enrolled" },
                version: 0,
            });
            await expect(
                fixture.client.applyHappyCloudCommand(
                    command("enroll", 0, { action: "set_enrollment", state: "enrolled" }),
                ),
            ).resolves.toMatchObject({ status: { version: 1 } });
            await fixture.client.applyHappyCloudCommand(
                command("profile-consent", 1, {
                    action: "set_capability",
                    capability: "happy_profile",
                    consent: "granted",
                }),
            );
            await fixture.client.applyHappyCloudCommand(
                command("profile", 2, {
                    action: "put_profile",
                    ciphertext: "b3BhcXVlX3Byb2ZpbGVfY2lwaGVydGV4dA",
                }),
            );
            await expect(fixture.client.getHappyCloudProfile()).resolves.toEqual({
                ciphertext: "b3BhcXVlX3Byb2ZpbGVfY2lwaGVydGV4dA",
                version: 3,
            });

            const malformed = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                {
                    ...command("bad", 3, {
                        action: "set_capability",
                        capability: "friends",
                        consent: "granted",
                    }),
                    surprise: true,
                },
            );
            expect(malformed.status).toBe(400);
            expect(fixture.service.status().version).toBe(3);
            const futureContract = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                {
                    ...command("future-contract", 3, {
                        action: "set_capability",
                        capability: "friends",
                        consent: "granted",
                    }),
                    contractVersion: 2,
                },
            );
            expect(futureContract.status).toBe(400);

            const missingMutationHeader = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                command("missing-header", 3, {
                    action: "set_capability",
                    capability: "friends",
                    consent: "granted",
                }),
                false,
            );
            expect(missingMutationHeader.status).toBe(400);

            const wrongCommandMethod = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                {},
                true,
                "GET",
            );
            expect(wrongCommandMethod).toMatchObject({ allow: "POST", status: 405 });
            const wrongStatusMethod = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/status",
                {},
            );
            expect(wrongStatusMethod).toMatchObject({ allow: "GET", status: 405 });
            const invalidBlobId = await rawRequest(
                fixture.socketPath,
                "secret",
                `/happy-cloud/session-blobs/${"x".repeat(257)}`,
                {},
                true,
                "GET",
            );
            expect(invalidBlobId.status).toBe(400);

            const boundaryCiphertext = "A".repeat(HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH);
            const boundary = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                command("boundary", 3, {
                    action: "put_profile",
                    ciphertext: boundaryCiphertext,
                }),
            );
            expect(boundary.status).toBe(200);
            const oversized = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                command("oversized", 4, {
                    action: "put_profile",
                    ciphertext: `${boundaryCiphertext}A`,
                }),
            );
            expect(oversized.status).toBe(400);
            const bodyTooLarge = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                command("body-too-large", 4, {
                    action: "put_profile",
                    ciphertext: `${boundaryCiphertext}${"A".repeat(5_000)}`,
                }),
            );
            expect(bodyTooLarge.status).toBe(413);

            const unauthorized = await rawRequest(
                fixture.socketPath,
                "wrong",
                "/happy-cloud/commands",
                command("unauthorized", 3, {
                    action: "set_capability",
                    capability: "friends",
                    consent: "granted",
                }),
            );
            expect(unauthorized.status).toBe(401);
        } finally {
            await fixture.close();
        }
    });

    it("reports stale reordered commands as conflicts without changing state", async () => {
        const fixture = await startServer();
        try {
            const enroll = command("same", 0, {
                action: "set_enrollment",
                state: "enrolled",
            });
            const first = await fixture.client.applyHappyCloudCommand(enroll);
            await expect(fixture.client.applyHappyCloudCommand(enroll)).resolves.toEqual(first);
            await expect(
                fixture.client.applyHappyCloudCommand(
                    command("stale", 0, {
                        action: "set_capability",
                        capability: "remote_control",
                        consent: "granted",
                    }),
                ),
            ).rejects.toMatchObject({ statusCode: 409 });
            expect(fixture.service.status().capabilities.remote_control.consent).toBe("denied");
        } finally {
            await fixture.close();
        }
    });

    it("reports unexpected service failures as server errors", async () => {
        const fixture = await startServer();
        try {
            fixture.service.apply = () => {
                throw new Error("unexpected cloud failure");
            };
            const response = await rawRequest(
                fixture.socketPath,
                "secret",
                "/happy-cloud/commands",
                command("unexpected", 0, {
                    action: "set_enrollment",
                    state: "enrolled",
                }),
            );
            expect(response).toMatchObject({
                body: { error: "unexpected cloud failure" },
                status: 500,
            });
        } finally {
            await fixture.close();
        }
    });

    it("delivers one committed lightweight change through the real live SSE route", async () => {
        const fixture = await startServer();
        const stream = await openLiveStream(fixture.socketPath, "secret");
        try {
            await stream.waitFor("event: hello");
            await fixture.client.applyHappyCloudCommand(
                command("live-enrollment", 0, {
                    action: "set_enrollment",
                    state: "enrolled",
                }),
            );
            const delivered = await stream.waitFor("happy_cloud_changed");
            expect(delivered).toContain('"mutationId":"live-enrollment"');
            expect(delivered).toContain('"version":1');
            expect(delivered).not.toContain('"status"');
        } finally {
            stream.close();
            await fixture.close();
        }
    });
});

function command(
    mutationId: string,
    expectedVersion: number,
    input: OmitDistributive<
        HappyCloudCommand,
        "contractVersion" | "expectedVersion" | "mutationId"
    >,
): HappyCloudCommand {
    return {
        ...input,
        contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
        expectedVersion,
        mutationId,
    } as HappyCloudCommand;
}

type OmitDistributive<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

async function startServer() {
    const directory = await createTestSocketDirectory();
    directories.push(directory);
    const socketPath = join(directory, "rig.sock");
    const store = new PersistentSessionStore({
        databasePath: join(directory, "sessions.sqlite"),
    });
    const service = store.happyCloud;
    const server = createProtocolHttpServer({ happyCloud: service, store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return {
        client: new ProtocolHttpClient({ socketPath, token: "secret" }),
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            store.close();
        },
        service,
        socketPath,
    };
}

async function rawRequest(
    socketPath: string,
    token: string,
    path: string,
    body: unknown,
    includeMutationHeader = true,
    method = "POST",
): Promise<{ allow: string | undefined; body: unknown; status: number }> {
    const payload = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-length": Buffer.byteLength(payload),
                    "content-type": "application/json",
                    ...(includeMutationHeader ? mutationHeaders(body) : {}),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        allow:
                            typeof response.headers.allow === "string"
                                ? response.headers.allow
                                : undefined,
                        body: text.length === 0 ? undefined : JSON.parse(text),
                        status: response.statusCode ?? 500,
                    });
                });
            },
        );
        request.on("error", reject);
        request.end(payload);
    });
}

function mutationHeaders(body: unknown): Record<string, string> {
    if (body === null || typeof body !== "object" || !("mutationId" in body)) return {};
    return typeof body.mutationId === "string" ? { "x-rig-mutation-id": body.mutationId } : {};
}

async function openLiveStream(
    socketPath: string,
    token: string,
): Promise<{ close: () => void; waitFor: (needle: string) => Promise<string> }> {
    return await new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: {
                    accept: "text/event-stream",
                    authorization: `Bearer ${token}`,
                },
                method: "GET",
                path: "/events/live",
                socketPath,
            },
            (response) => {
                let text = "";
                const waiters: Array<{ needle: string; resolve: (value: string) => void }> = [];
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    text += chunk;
                    for (let index = waiters.length - 1; index >= 0; index -= 1) {
                        const waiter = waiters[index];
                        if (waiter === undefined) continue;
                        if (!text.includes(waiter.needle)) continue;
                        waiter.resolve(text);
                        waiters.splice(index, 1);
                    }
                });
                response.on("error", reject);
                resolve({
                    close: () => {
                        response.destroy();
                        request.destroy();
                    },
                    waitFor: (needle) =>
                        text.includes(needle)
                            ? Promise.resolve(text)
                            : new Promise<string>((resolveWaiter) =>
                                  waiters.push({ needle, resolve: resolveWaiter }),
                              ),
                });
            },
        );
        request.on("error", reject);
        request.end();
    });
}
