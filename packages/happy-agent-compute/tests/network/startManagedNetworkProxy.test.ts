import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    ManagedNetworkHttpRequest,
    ManagedNetworkInterceptor,
    ManagedNetworkRequestCompletion,
    ManagedNetworkTunnel,
} from "../../sources/network/ManagedNetworkPolicy.js";
import { isNonPublicAddress } from "../../sources/network/impl/resolveEgressAddress.js";
import { startManagedNetworkProxy } from "../../sources/network/startManagedNetworkProxy.js";

const closeables: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
});

/**
 * A minimal interceptor standing in for the plugin network layer that lives above the compute. It
 * only exercises the proxy's boundary and fail-open behavior; it holds no policy of its own.
 */
function fakeInterceptor(options: {
    domains: readonly string[];
    onRequest?: (request: ManagedNetworkHttpRequest) => Promise<ManagedNetworkRequestCompletion>;
}): {
    interceptor: ManagedNetworkInterceptor;
    failures: Array<{ error: unknown; hostname: string }>;
    tunnels: ManagedNetworkTunnel[];
} {
    const failures: Array<{ error: unknown; hostname: string }> = [];
    const tunnels: ManagedNetworkTunnel[] = [];
    const interceptor: ManagedNetworkInterceptor = {
        shouldIntercept: (hostname) => options.domains.includes(hostname),
        interceptHttp: (request) =>
            options.onRequest?.(request) ?? Promise.resolve({ type: "pass_through" }),
        observeTunnel: (tunnel) => tunnels.push(tunnel),
        recordFailure: (hostname, error) => failures.push({ error, hostname }),
    };
    return { failures, interceptor, tunnels };
}

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
    ])("classifies non-public address %s as blocked", (address) => {
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

    it("accepts the unrestricted host rule used by an operation with unbounded egress", async () => {
        const upstream = createServer((socket) => socket.pipe(socket));
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing TCP port.");
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "*" }] },
            { resolveAddress: async () => "127.0.0.1" },
        );
        closeables.push(proxy);

        const response = await connectThroughProxy(proxy.port, `anything.example:${address.port}`);

        expect(response).toContain("200 Connection Established");
    });

    it("allows private destinations only when unrestricted egress explicitly grants them", async () => {
        const upstream = createServer((socket) => socket.pipe(socket));
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing TCP port.");
        const restricted = await startManagedNetworkProxy({
            allowedDomains: [{ domain: "*" }],
        });
        closeables.push(restricted);
        const unrestricted = await startManagedNetworkProxy({
            allowPrivateAddresses: true,
            allowedDomains: [{ domain: "*" }],
        });
        closeables.push(unrestricted);

        const blocked = await connectThroughProxy(
            restricted.port,
            `127.0.0.1:${String(address.port)}`,
        );
        const allowed = await connectThroughProxy(
            unrestricted.port,
            `127.0.0.1:${String(address.port)}`,
        );

        expect(blocked).toContain("403 Forbidden");
        expect(blocked).toContain("X-Proxy-Error: blocked-private-address");
        expect(allowed).toContain("200 Connection Established");
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
        expect(proxy.blockedRequest()?.reason).toBe("dns_resolution_failed");
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
        expect(proxy.blockedRequest()?.reason).toBe("dns_resolution_failed");
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

    it("returns an interceptor's synthetic HTTP response", async () => {
        const resolveAddress = vi.fn(async () => "127.0.0.1");
        const { interceptor } = fakeInterceptor({
            domains: ["intercept.example"],
            onRequest: async () => ({
                bodyBase64: Buffer.from("from interceptor").toString("base64"),
                headers: { "content-type": "text/plain", "x-interceptor": "yes" },
                status: 201,
                type: "response",
            }),
        });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "intercept.example", ports: [80] }] },
            { networkInterceptor: interceptor, resolveAddress },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(proxy.port, "http://intercept.example/resource");

        expect(response).toMatchObject({
            body: "from interceptor",
            headers: expect.objectContaining({ "x-interceptor": "yes" }),
            status: 201,
        });
        // A synthetic response never leaves the proxy, so it never resolves the destination.
        expect(resolveAddress).not.toHaveBeenCalled();
    });

    it("forwards an interceptor-rewritten HTTP request", async () => {
        const received: Array<{ body: string; method?: string; url?: string }> = [];
        const upstream = createHttpServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received.push({
                body: Buffer.concat(chunks).toString("utf8"),
                ...(request.method === undefined ? {} : { method: request.method }),
                ...(request.url === undefined ? {} : { url: request.url }),
            });
            response.end("forwarded");
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const { interceptor } = fakeInterceptor({
            domains: ["rewrite.example"],
            onRequest: async () => ({
                bodyBase64: Buffer.from("rewritten body").toString("base64"),
                headers: { "x-rewritten": "true" },
                method: "PUT",
                type: "request",
                url: `http://rewrite.example:${String(address.port)}/changed`,
            }),
        });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "rewrite.example", ports: [address.port] }] },
            { networkInterceptor: interceptor, resolveAddress: async () => "127.0.0.1" },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(
            proxy.port,
            `http://rewrite.example:${String(address.port)}/original`,
            { body: "original body", method: "POST" },
        );

        expect(response.body).toBe("forwarded");
        expect(received).toEqual([{ body: "rewritten body", method: "PUT", url: "/changed" }]);
    });

    it("does not let an interceptor declaration make a policy-blocked domain reachable", async () => {
        const onRequest = vi.fn(async () => ({ type: "pass_through" }) as const);
        const resolveAddress = vi.fn(async () => "127.0.0.1");
        const { interceptor } = fakeInterceptor({ domains: ["blocked.example"], onRequest });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "allowed.example", ports: [80] }] },
            { networkInterceptor: interceptor, resolveAddress },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(proxy.port, "http://blocked.example/");

        expect(response.status).toBe(403);
        expect(response.body).toBe("Domain not in allowlist.");
        expect(onRequest).not.toHaveBeenCalled();
        expect(resolveAddress).not.toHaveBeenCalled();
    });

    it("fails open without leaking a synthetic response that carries invalid headers", async () => {
        const upstream = createHttpServer((_request, response) => {
            response.writeHead(200, { "x-upstream": "clean" }).end("normal response");
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const { failures, interceptor } = fakeInterceptor({
            domains: ["headers.example"],
            onRequest: async () => ({
                headers: { "x-invalid": "line one\nline two", "x-plugin": "must-not-leak" },
                status: 201,
                type: "response",
            }),
        });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "headers.example", ports: [address.port] }] },
            { networkInterceptor: interceptor, resolveAddress: async () => "127.0.0.1" },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(
            proxy.port,
            `http://headers.example:${String(address.port)}/`,
        );

        expect(response).toMatchObject({
            body: "normal response",
            headers: expect.objectContaining({ "x-upstream": "clean" }),
            status: 200,
        });
        expect(response.headers["x-plugin"]).toBeUndefined();
        expect(failures).toHaveLength(1);
    });

    it("bounds interception body capture time and replays the complete streaming body", async () => {
        const received: string[] = [];
        let markUpstreamStarted!: () => void;
        const upstreamStarted = new Promise<void>((resolve) => {
            markUpstreamStarted = resolve;
        });
        const upstream = createHttpServer(async (request, response) => {
            markUpstreamStarted();
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received.push(Buffer.concat(chunks).toString("utf8"));
            response.end("stream forwarded");
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const onRequest = vi.fn(async () => ({ type: "pass_through" }) as const);
        const { failures, interceptor } = fakeInterceptor({
            domains: ["stream.example"],
            onRequest,
        });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "stream.example", ports: [address.port] }] },
            {
                interceptionBodyTimeoutMs: 10,
                networkInterceptor: interceptor,
                resolveAddress: async () => "127.0.0.1",
            },
        );
        closeables.push(proxy);
        const streaming = streamingRequestThroughProxy(
            proxy.port,
            `http://stream.example:${String(address.port)}/`,
        );
        streaming.request.write("first");

        await upstreamStarted;
        streaming.request.end("second");
        const response = await streaming.response;

        expect(response.body).toBe("stream forwarded");
        expect(received).toEqual(["firstsecond"]);
        // The interceptor never sees a body it could not capture in time.
        expect(onRequest).not.toHaveBeenCalled();
        expect(failures).toEqual([
            {
                error: expect.objectContaining({
                    message: "The HTTP request body did not finish within 10ms.",
                }),
                hostname: "stream.example",
            },
        ]);
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

function requestThroughProxy(
    proxyPort: number,
    target: string,
    options: { body?: string; method?: string } = {},
): Promise<{ body: string; headers: import("node:http").IncomingHttpHeaders; status: number }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers:
                    options.body === undefined
                        ? {}
                        : { "content-length": Buffer.byteLength(options.body) },
                host: "127.0.0.1",
                method: options.method ?? "GET",
                path: target,
                port: proxyPort,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                response.once("end", () => {
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 500,
                    });
                });
            },
        );
        request.once("error", reject);
        request.end(options.body);
    });
}

function streamingRequestThroughProxy(
    proxyPort: number,
    target: string,
): {
    request: ReturnType<typeof httpRequest>;
    response: Promise<{
        body: string;
        headers: import("node:http").IncomingHttpHeaders;
        status: number;
    }>;
} {
    let resolveResponse!: (response: {
        body: string;
        headers: import("node:http").IncomingHttpHeaders;
        status: number;
    }) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<{
        body: string;
        headers: import("node:http").IncomingHttpHeaders;
        status: number;
    }>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
    });
    const request = httpRequest(
        {
            headers: { "transfer-encoding": "chunked" },
            host: "127.0.0.1",
            method: "POST",
            path: target,
            port: proxyPort,
        },
        (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            incoming.once("end", () => {
                resolveResponse({
                    body: Buffer.concat(chunks).toString("utf8"),
                    headers: incoming.headers,
                    status: incoming.statusCode ?? 500,
                });
            });
        },
    );
    request.once("error", rejectResponse);
    request.flushHeaders();
    return { request, response };
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
