import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HappyCloudService } from "../../happy-cloud/index.js";
import { HAPPY_CLOUD_CONTRACT_VERSION, type HappyCloudCommand } from "../../protocol/index.js";
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
                    ciphertext: "opaque-profile-ciphertext",
                }),
            );
            await expect(fixture.client.getHappyCloudProfile()).resolves.toEqual({
                ciphertext: "opaque-profile-ciphertext",
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
    const service = new HappyCloudService(join(directory, "sessions.sqlite"));
    const server = createProtocolHttpServer({ happyCloud: service, token: "secret" });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return {
        client: new ProtocolHttpClient({ socketPath, token: "secret" }),
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            service.close();
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
): Promise<{ body: unknown; status: number }> {
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
                method: "POST",
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
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
