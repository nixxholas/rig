import { request } from "node:http";
import type { Server } from "node:http";

import type { Span, Tracer } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import type { P2pNetwork } from "../../p2p/index.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("protocol request contexts", () => {
    it("uses a semantic route span name without request entity IDs", async () => {
        const spanNames: string[] = [];
        const tracer = {
            startSpan(name: string) {
                spanNames.push(name);
                return testSpan();
            },
        } as unknown as Tracer;
        const root = createTestRootContext(tracer);
        const directory = await createTestSocketDirectory();
        const socketPath = `${directory}/server.sock`;
        const server = await createProtocolHttpServer(root, { token: "secret" });
        await listen(server, socketPath);
        try {
            spanNames.length = 0;
            const sessionId = "session-id-that-must-not-be-a-span-name";
            const headers = await send(socketPath, `/sessions/${sessionId}/state`);

            expect(spanNames).toEqual(["rig.api.session-state"]);
            expect(spanNames.join(" ")).not.toContain(sessionId);
            expect(headers["x-rig-trace-id"]).toBe("1".repeat(32));
        } finally {
            await close(server);
        }
    });

    it("does not create traces for rejected peer API polling", async () => {
        const spanNames: string[] = [];
        const tracer = {
            startSpan(name: string) {
                spanNames.push(name);
                return testSpan();
            },
        } as unknown as Tracer;
        const root = createTestRootContext(tracer);
        const directory = await createTestSocketDirectory();
        const socketPath = `${directory}/server.sock`;
        const server = await createProtocolHttpServer(root, {
            resolveP2pNetwork: () => ({ peerApiAvailable: () => false }) as unknown as P2pNetwork,
            token: "secret",
        });
        await listen(server, socketPath);
        try {
            spanNames.length = 0;
            await send(socketPath, "/p2p/peers/aremoteinstance0000000001/api/catalog");
            expect(spanNames).toEqual([]);
        } finally {
            await close(server);
        }
    });
});

function testSpan(): Span {
    const span: Span = {
        addEvent: () => span,
        addLink: () => span,
        addLinks: () => span,
        end: () => undefined,
        isRecording: () => true,
        recordException: () => undefined,
        setAttribute: () => span,
        setAttributes: () => span,
        setStatus: () => span,
        spanContext: () => ({ spanId: "2".repeat(16), traceFlags: 1, traceId: "1".repeat(32) }),
        updateName: () => span,
    };
    return span;
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function send(socketPath: string, path: string): Promise<import("node:http").IncomingHttpHeaders> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: { authorization: "Bearer secret" },
                method: "GET",
                path,
                socketPath,
            },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.headers));
            },
        );
        outgoing.once("error", reject);
        outgoing.end();
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}
