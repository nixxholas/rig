import { connect, createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { DirectTlsNetwork } from "./DirectTlsNetwork.js";

describe("direct TLS P2P transport", () => {
    it("authenticates both stable identities and forwards streaming HTTP in either direction", async () => {
        const [firstPort, secondPort] = await Promise.all([reservePort(), reservePort()]);
        const firstIdentity = createP2pInstanceIdentity(
            "ck1234567890abcdefghijkl",
            Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        );
        const secondIdentity = createP2pInstanceIdentity(
            "dk1234567890abcdefghijkl",
            Uint8Array.from({ length: 32 }, (_, index) => index + 33),
        );
        const firstAddress = `127.0.0.1:${String(firstPort)}`;
        const secondAddress = `127.0.0.1:${String(secondPort)}`;
        const first = await DirectTlsNetwork.create({
            config: { listen: firstAddress },
            identity: firstIdentity,
            peers: [
                {
                    direct: { address: secondAddress },
                    instanceId: secondIdentity.instanceId,
                    publicKey: secondIdentity.publicKey,
                },
            ],
            serveRequest: async (peerId) => response(peerId),
        });
        const second = await DirectTlsNetwork.create({
            config: { listen: secondAddress },
            identity: secondIdentity,
            peers: [
                {
                    direct: { address: firstAddress },
                    instanceId: firstIdentity.instanceId,
                    publicKey: firstIdentity.publicKey,
                },
            ],
            serveRequest: async (peerId) => response(peerId),
        });
        try {
            const firstResponse = await first.fetch(
                secondIdentity.instanceId,
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                new AbortController().signal,
            );
            expect(firstResponse.status).toBe(200);
            expect(await collect(firstResponse.body)).toBe(firstIdentity.instanceId);

            const secondResponse = await second.fetch(
                firstIdentity.instanceId,
                { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                new AbortController().signal,
            );
            expect(await collect(secondResponse.body)).toBe(secondIdentity.instanceId);
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    });

    it("refuses a TLS identity key that is not on the configured peer allowlist", async () => {
        const [firstPort, secondPort] = await Promise.all([reservePort(), reservePort()]);
        const firstIdentity = createP2pInstanceIdentity();
        const secondIdentity = createP2pInstanceIdentity();
        const impostorIdentity = createP2pInstanceIdentity();
        const first = await DirectTlsNetwork.create({
            config: { listen: `127.0.0.1:${String(firstPort)}` },
            identity: firstIdentity,
            peers: [
                {
                    direct: { address: `127.0.0.1:${String(secondPort)}` },
                    instanceId: secondIdentity.instanceId,
                    publicKey: secondIdentity.publicKey,
                },
            ],
        });
        const impostor = await DirectTlsNetwork.create({
            config: { listen: `127.0.0.1:${String(secondPort)}` },
            identity: impostorIdentity,
            peers: [
                {
                    direct: { address: `127.0.0.1:${String(firstPort)}` },
                    instanceId: firstIdentity.instanceId,
                    publicKey: firstIdentity.publicKey,
                },
            ],
        });
        try {
            await expect(
                first.fetch(
                    secondIdentity.instanceId,
                    { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
                    new AbortController().signal,
                ),
            ).rejects.toThrow("certificate key does not match");
        } finally {
            await Promise.all([first.close(), impostor.close()]);
        }
    });

    it("keeps inbound capacity reserved while a TLS client stalls before hello", async () => {
        const port = await reservePort();
        const network = await DirectTlsNetwork.create({
            config: { listen: `127.0.0.1:${String(port)}` },
            identity: createP2pInstanceIdentity(),
            maximumConnections: 2,
            peers: [],
        });
        const first = connect(port, "127.0.0.1");
        const second = connect(port, "127.0.0.1");
        const third = connect(port, "127.0.0.1");
        const thirdClosed = new Promise<void>((resolve) => third.once("close", () => resolve()));
        try {
            await Promise.all([connected(first), connected(second)]);
            await thirdClosed;
            expect(first.destroyed).toBe(false);
            expect(second.destroyed).toBe(false);
        } finally {
            first.destroy();
            second.destroy();
            third.destroy();
            await network.close();
        }
    });

    it("reserves outbound capacity for the full streaming response lifetime", async () => {
        const [clientPort, serverPort] = await Promise.all([reservePort(), reservePort()]);
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const clientAddress = `127.0.0.1:${String(clientPort)}`;
        const serverAddress = `127.0.0.1:${String(serverPort)}`;
        const client = await DirectTlsNetwork.create({
            config: { listen: clientAddress },
            identity: clientIdentity,
            maximumConnections: 2,
            peers: [
                {
                    direct: { address: serverAddress },
                    instanceId: serverIdentity.instanceId,
                    publicKey: serverIdentity.publicKey,
                },
            ],
            startPings: false,
        });
        const server = await DirectTlsNetwork.create({
            closeTimeoutMs: 100,
            config: { listen: serverAddress },
            identity: serverIdentity,
            peers: [
                {
                    direct: { address: clientAddress },
                    instanceId: clientIdentity.instanceId,
                    publicKey: clientIdentity.publicKey,
                },
            ],
            serveRequest: async (_peerId, _request, signal) => ({
                body: (async function* () {
                    await waitForAbort(signal);
                })(),
                headers: {},
                status: 200,
            }),
            startPings: false,
        });
        const controllers = [new AbortController(), new AbortController()];
        try {
            await deadline(
                Promise.all(
                    controllers.map((controller) =>
                        client.fetch(
                            serverIdentity.instanceId,
                            {
                                body: Buffer.alloc(0),
                                headers: {},
                                method: "GET",
                                path: "/events/live",
                            },
                            controller.signal,
                        ),
                    ),
                ),
                "The two streaming direct requests did not open.",
            );

            await expect(
                client.fetch(
                    serverIdentity.instanceId,
                    { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/health" },
                    new AbortController().signal,
                ),
            ).rejects.toThrow("Too many outbound direct P2P connections");
        } finally {
            for (const controller of controllers) controller.abort();
            await deadline(client.close(), "The direct client did not close.");
            await deadline(server.close(), "The direct server did not close.");
        }
    });
});

function response(peerId: string) {
    return {
        body: (async function* () {
            yield Buffer.from(peerId);
        })(),
        headers: { "content-type": "text/plain" },
        status: 200,
    };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP port.");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

function connected(socket: ReturnType<typeof connect>): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}

function deadline<T>(operation: Promise<T>, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), 1_000);
        void operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
