import { createServer } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isNonPublicAddress, startManagedNetworkProxy } from "./startManagedNetworkProxy.js";

const closeables: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
});

describe("startManagedNetworkProxy", () => {
    it.each([
        "169.254.169.254",
        "::ffff:169.254.169.254",
        "::ffff:a9fe:a9fe",
        "0:0:0:0:0:ffff:a9fe:a9fe",
        "100.100.100.200",
        "192.0.2.1",
        "198.51.100.1",
        "203.0.113.1",
        "fc00::1",
        "fe80::1",
    ])("classifies Codex non-public address %s as blocked", (address) => {
        expect(isNonPublicAddress(address)).toBe(true);
    });

    it.each(["8.8.8.8", "2606:4700:4700::1111"])(
        "classifies public address %s as reachable",
        (address) => {
            expect(isNonPublicAddress(address)).toBe(false);
        },
    );

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
        expect(response).toContain("X-Proxy-Error: blocked-by-denylist");
        expect(response).toContain("Domain denied by the sandbox policy.");
        expect(proxy.blockedRequest()).toEqual({
            host: "blocked.example.com",
            port: 443,
            protocol: "https_connect",
            reason: "denied",
        });
    });

    it("denies external destinations when the allowlist is empty", async () => {
        const resolveAddress = vi.fn(async () => "203.0.113.1");
        const proxy = await startManagedNetworkProxy({}, { resolveAddress });
        closeables.push(proxy);
        const onBlockedRequest = vi.fn();
        proxy.onBlockedRequest(onBlockedRequest);

        const response = await connectThroughProxy(proxy.port, "anything.example:443");

        expect(response).toContain("403 Forbidden");
        expect(resolveAddress).not.toHaveBeenCalled();
        expect(onBlockedRequest).toHaveBeenCalledOnce();
        expect(onBlockedRequest).toHaveBeenCalledWith({
            host: "anything.example",
            port: 443,
            protocol: "https_connect",
            reason: "not_allowed",
        });
    });

    it("treats a DNS lookup failure as a blocked policy result", async () => {
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "allowed.example", ports: [443] }] },
            {
                resolveAddress: async () => {
                    throw new Error("resolver failed");
                },
            },
        );
        closeables.push(proxy);

        const response = await connectThroughProxy(proxy.port, "allowed.example:443");

        expect(response).toContain("403 Forbidden");
        expect(response).toContain("X-Proxy-Error: blocked-dns-resolution");
        expect(proxy.blockedRequest()).toEqual({
            host: "allowed.example",
            port: 443,
            protocol: "https_connect",
            reason: "dns_resolution_failed",
        });
    });

    it("bounds DNS lookup time and treats a timeout as a blocked policy result", async () => {
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "allowed.example", ports: [443] }] },
            {
                resolveAddress: () => new Promise<string>(() => {}),
                resolveTimeoutMs: 10,
            },
        );
        closeables.push(proxy);

        const response = await connectThroughProxy(proxy.port, "allowed.example:443");

        expect(response).toContain("403 Forbidden");
        expect(response).toContain("X-Proxy-Error: blocked-dns-resolution");
        expect(proxy.blockedRequest()).toEqual({
            host: "allowed.example",
            port: 443,
            protocol: "https_connect",
            reason: "dns_resolution_failed",
        });
    });

    it("does not open an upstream after closing during address resolution", async () => {
        let releaseResolution!: () => void;
        const resolution = new Promise<string>((resolve) => {
            releaseResolution = () => resolve("203.0.113.1");
        });
        let markResolutionStarted!: () => void;
        const resolutionStarted = new Promise<void>((resolve) => {
            markResolutionStarted = resolve;
        });
        const connectUpstream = vi.fn(() => {
            throw new Error("Upstream must not be opened.");
        });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "allowed.example", ports: [443] }] },
            {
                connectUpstream,
                resolveAddress: async () => {
                    markResolutionStarted();
                    return resolution;
                },
            },
        );
        closeables.push(proxy);
        const socket = connect(proxy.port, "127.0.0.1");
        socket.once("connect", () => {
            socket.write(
                "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
            );
        });
        await resolutionStarted;

        await proxy.close();
        releaseResolution();
        await resolution;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(connectUpstream).not.toHaveBeenCalled();
    });

    it("closes the HTTP listener when the SOCKS listener cannot start", async () => {
        const occupied = createServer();
        await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => occupied.close(() => resolve())),
        });
        const occupiedAddress = occupied.address();
        if (occupiedAddress === null || typeof occupiedAddress === "string") {
            throw new Error("Missing occupied TCP port.");
        }
        let httpPort: number | undefined;

        await expect(
            startManagedNetworkProxy(
                { allowedDomains: [{ domain: "allowed.example", ports: [443] }] },
                {
                    onHttpListening(port) {
                        httpPort = port;
                    },
                    socksPort: occupiedAddress.port,
                },
            ),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });

        expect(httpPort).toBeTypeOf("number");
        await expect(canConnect(httpPort!)).resolves.toBe(false);
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

async function canConnect(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}
