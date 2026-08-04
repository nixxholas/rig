import { createServer, type Server, Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteTerminalProtocolClient } from "./RemoteTerminalProtocolClient.js";
import {
    RemoteTerminalProtocolServer,
    type RemoteTerminalAttachOptions,
} from "./RemoteTerminalProtocolServer.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// A promise that never settles, standing in for a viewer's replica that never gets
// around to acknowledging output — the read-only equivalent of a client that hangs.
const never = new Promise<void>(() => {});

describe("a read-only viewer never backpressures the owner's process", () => {
    it("does not pause flow control when a viewer stops acknowledging output", async () => {
        const flow: boolean[] = [];
        const protocol = new RemoteTerminalProtocolServer({
            maxUnacknowledgedBytes: 96,
            wireChunkBytes: 96,
            onFlowControl: (paused) => flow.push(paused),
            onInput() {},
            onResize() {},
        });
        const endpoint = await listen(protocol, { input: false });
        const client = new RemoteTerminalProtocolClient({
            capabilities: { grid: false, vt: true },
            clientId: "stalled-viewer",
            creditBytes: 96,
            replica: {
                applyGrid() {},
                applyVt: () => never,
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await client.ready;

        protocol.publishOutput(Buffer.alloc(1_024, 0x61));
        // Give the queued chunks a turn to be processed; a regression would call
        // onFlowControl synchronously within publishOutput, so this also guards
        // against a fix that only defers the call rather than suppressing it.
        await new Promise((resolve) => setImmediate(resolve));

        expect(flow).toEqual([]);
    });

    it("still pauses flow control when a writer stops acknowledging output (no regression)", async () => {
        const flow: boolean[] = [];
        const protocol = new RemoteTerminalProtocolServer({
            maxUnacknowledgedBytes: 96,
            wireChunkBytes: 96,
            onFlowControl: (paused) => flow.push(paused),
            onInput() {},
            onResize() {},
        });
        const endpoint = await listen(protocol);
        const client = new RemoteTerminalProtocolClient({
            capabilities: { grid: false, vt: true },
            clientId: "stalled-writer",
            creditBytes: 96,
            replica: {
                applyGrid() {},
                applyVt: () => never,
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await client.ready;

        protocol.publishOutput(Buffer.alloc(1_024, 0x61));

        await vi.waitFor(() => expect(flow).toContain(true));
    });

    it("drops a viewer that falls too far behind without ever touching the owner's flow", async () => {
        const flow: boolean[] = [];
        const protocol = new RemoteTerminalProtocolServer({
            maxBufferedBytes: 4_096,
            wireChunkBytes: 1_024,
            onFlowControl: (paused) => flow.push(paused),
            onInput() {},
            onResize() {},
        });
        const endpoint = await listen(protocol);

        const viewerSocket = await endpoint.connect({ input: false });
        const viewer = new RemoteTerminalProtocolClient({
            capabilities: { grid: false, vt: true },
            clientId: "flooded-viewer",
            creditBytes: 1_024,
            replica: {
                applyGrid() {},
                applyVt: () => never,
                resize() {},
            },
            stream: viewerSocket,
        });
        await viewer.ready;

        let ownerReceived = 0;
        const owner = new RemoteTerminalProtocolClient({
            capabilities: { grid: false, vt: true },
            clientId: "owner",
            replica: {
                applyGrid() {},
                applyVt(data) {
                    ownerReceived += data.length;
                },
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await owner.ready;

        const payload = Buffer.alloc(64 * 1_024, 0x62);
        protocol.publishOutput(payload);

        await vi.waitFor(() => expect(viewerSocket.destroyed).toBe(true));
        await vi.waitFor(() => expect(ownerReceived).toBe(payload.length));
        expect(flow).toEqual([]);
    });
});

async function listen(
    protocol: RemoteTerminalProtocolServer,
    defaultAttachOptions?: RemoteTerminalAttachOptions,
): Promise<{ connect: (attachOptions?: RemoteTerminalAttachOptions) => Promise<Socket> }> {
    const sockets = new Set<Socket>();
    // Connections are attached in the order they are made, which the tests below rely
    // on by always awaiting one `connect()` before starting the next.
    const pendingOptions: (RemoteTerminalAttachOptions | undefined)[] = [];
    const server = createServer((socket) => {
        sockets.add(socket);
        protocol.attach(socket, pendingOptions.shift() ?? defaultAttachOptions);
        socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => closeServer(server, sockets));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing TCP address.");
    return {
        connect: (attachOptions?: RemoteTerminalAttachOptions) => {
            pendingOptions.push(attachOptions);
            return new Promise((resolve, reject) => {
                const socket = new Socket();
                socket.once("error", reject);
                socket.connect(address.port, "127.0.0.1", () => {
                    socket.off("error", reject);
                    resolve(socket);
                });
            });
        },
    };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
}
