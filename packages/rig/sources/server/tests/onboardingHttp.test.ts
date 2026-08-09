import { request, type Server } from "node:http";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OnboardingServiceContract } from "../../onboarding/OnboardingService.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("onboarding HTTP", () => {
    const close: (() => Promise<void>)[] = [];

    afterEach(async () => {
        await Promise.all(close.splice(0).map((stop) => stop()));
    });

    it("serves the onboarding status through the service", async () => {
        const onboarding: OnboardingServiceContract = {
            status: vi.fn<OnboardingServiceContract["status"]>(async () => ({
                onboardingVersion: 1,
                state: "complete",
            })),
        };
        const started = await startServer(
            createProtocolHttpServer({ onboarding, token: "secret" }),
        );
        close.push(started.close);

        expect(await send(started.socketPath, "GET", "/onboarding")).toEqual({
            body: { onboardingVersion: 1, state: "complete" },
            status: 200,
        });
        expect(onboarding.status).toHaveBeenCalledOnce();
    });

    it("keeps onboarding local and method-safe", async () => {
        const onboarding: OnboardingServiceContract = {
            status: vi.fn<OnboardingServiceContract["status"]>(async () => ({
                onboardingVersion: 1,
                state: "provider_setup",
            })),
        };
        const started = await startServer(
            createProtocolHttpServer({ onboarding, token: "secret" }),
        );
        close.push(started.close);

        expect(await send(started.socketPath, "POST", "/onboarding")).toMatchObject({
            status: 405,
        });
        expect(
            await send(started.socketPath, "GET", "/onboarding", "aprimaryinstance000000001"),
        ).toEqual({
            body: { error: "Onboarding is available only on the local Rig." },
            status: 403,
        });
        expect(onboarding.status).not.toHaveBeenCalled();
    });

    it("reports when daemon-owned onboarding is unavailable", async () => {
        const started = await startServer(createProtocolHttpServer({ token: "secret" }));
        close.push(started.close);

        expect(await send(started.socketPath, "GET", "/onboarding")).toEqual({
            body: { error: "Rig onboarding is unavailable." },
            status: 503,
        });
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    peerId?: string,
): Promise<{ body: unknown; status: number }> {
    return await new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
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
        outgoing.end();
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
