import { createServer } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startManagedNetworkProxy } from "./startManagedNetworkProxy.js";

const closeables: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
});

describe("startManagedNetworkProxy", () => {
    it("allows an exact CONNECT destination and carries the tunnel", async () => {
        const upstream = createServer((socket) => socket.pipe(socket));
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing TCP port.");
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "allowed.example", ports: [address.port] }] },
            { resolveAddress: async () => "127.0.0.1" },
        );
        closeables.push(proxy);

        const response = await connectThroughProxy(proxy.port, `allowed.example:${address.port}`);

        expect(response).toContain("200 Connection Established");
        expect(response).toContain("tunnel-body");
    });

    it("gives deny rules precedence over an allow wildcard", async () => {
        const proxy = await startManagedNetworkProxy({
            allowedDomains: [{ domain: "*.example.com", ports: [443] }],
            deniedDomains: [{ domain: "blocked.example.com" }],
        });
        closeables.push(proxy);

        const response = await connectThroughProxy(proxy.port, "blocked.example.com:443");

        expect(response).toContain("403 Forbidden");
    });
});

async function connectThroughProxy(port: number, authority: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        let output = "";
        socket.setEncoding("utf8");
        socket.once("error", reject);
        socket.on("data", (chunk) => {
            output += chunk;
            if (output.includes("\r\n\r\n") && output.includes("200 Connection Established")) {
                socket.write("tunnel-body");
            }
            if (output.includes("tunnel-body") || output.includes("403 Forbidden")) {
                socket.end();
                resolve(output);
            }
        });
        socket.once("connect", () => {
            socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
        });
    });
}
