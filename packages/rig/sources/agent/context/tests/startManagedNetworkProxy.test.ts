import { createServer } from "node:net";
import { connect } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HappyNetworkEvent } from "happy-plugins";
import { PluginNetworkRegistry } from "../../../plugins/PluginNetworkRegistry.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { isNonPublicAddress, startManagedNetworkProxy } from "../startManagedNetworkProxy.js";

const closeables: Array<{ close(): Promise<void> | void }> = [];

beforeEach(() => {
    createTestRootContext();
});

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

    it("returns a plugin's synthetic HTTP response", async () => {
        const { registry } = networkHandler(["intercept.example"], (event, connection, id) => {
            if (event.type !== "request" || event.mode !== "handle") return;
            connection.complete(id, event.callId, {
                bodyBase64: Buffer.from("from plugin").toString("base64"),
                headers: { "content-type": "text/plain", "x-plugin": "yes" },
                status: 201,
                type: "response",
            });
        });
        closeables.push({ close: () => registry.close() });
        const resolveAddress = vi.fn(async () => "127.0.0.1");
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "intercept.example", ports: [80] }] },
            { networkInterceptor: registry, resolveAddress },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(proxy.port, "http://intercept.example/resource");

        expect(response).toMatchObject({
            body: "from plugin",
            headers: expect.objectContaining({ "x-plugin": "yes" }),
            status: 201,
        });
        expect(resolveAddress).not.toHaveBeenCalled();
    });

    it("forwards a plugin-rewritten HTTP request", async () => {
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
        const { registry } = networkHandler(["rewrite.example"], (event, connection, id) => {
            if (event.type !== "request" || event.mode !== "handle") return;
            connection.complete(id, event.callId, {
                bodyBase64: Buffer.from("rewritten body").toString("base64"),
                headers: { "x-rewritten": "true" },
                method: "PUT",
                type: "request",
                url: `http://rewrite.example:${String(address.port)}/changed`,
            });
        });
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            {
                allowedDomains: [{ domain: "rewrite.example", ports: [address.port] }],
            },
            {
                networkInterceptor: registry,
                resolveAddress: async () => "127.0.0.1",
            },
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

    it("fails open to normal HTTP forwarding when a plugin misses its deadline", async () => {
        const upstream = createHttpServer((_request, response) => response.end("normal path"));
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const failures: string[] = [];
        const registry = new PluginNetworkRegistry({
            deadlineMs: 10,
            onFailure: (failure) => failures.push(failure.error),
        });
        const connection = registry.createConnection({
            folder: "slow-plugin",
            interceptDomains: ["slow.example"],
            name: "Slow plugin",
        });
        const registrationId = connection.register("request");
        connection.attach(registrationId, () => true);
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "slow.example", ports: [address.port] }] },
            {
                networkInterceptor: registry,
                resolveAddress: async () => "127.0.0.1",
            },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(
            proxy.port,
            `http://slow.example:${String(address.port)}/`,
        );

        expect(response.body).toBe("normal path");
        expect(failures).toEqual(["The network handler exceeded its deadline."]);
    });

    it("leaves an undeclared HTTP domain completely untouched by plugin interception", async () => {
        const upstream = createHttpServer((_request, response) =>
            response.end("stream reached upstream"),
        );
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const onEvent = vi.fn(() => true);
        const failures: string[] = [];
        const registry = new PluginNetworkRegistry({
            onFailure: (failure) => failures.push(failure.error),
        });
        const connection = registry.createConnection({
            folder: "declared-plugin",
            interceptDomains: ["declared.example"],
            name: "Declared plugin",
        });
        const registrationId = connection.register("request");
        connection.attach(registrationId, onEvent);
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "other.example", ports: [address.port] }] },
            {
                networkInterceptor: registry,
                resolveAddress: async () => "127.0.0.1",
            },
        );
        closeables.push(proxy);

        const streaming = streamingRequestThroughProxy(
            proxy.port,
            `http://other.example:${String(address.port)}/`,
        );
        streaming.request.write("body has not ended");
        const response = await streaming.response;
        streaming.request.destroy();

        expect(response.body).toBe("stream reached upstream");
        expect(onEvent).not.toHaveBeenCalled();
        expect(failures).toEqual([]);
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
        const failures: Array<{ error: string; pluginFolder: string }> = [];
        const registry = new PluginNetworkRegistry({
            onFailure: (failure) =>
                failures.push({
                    error: failure.error,
                    pluginFolder: failure.pluginFolder,
                }),
        });
        const connection = registry.createConnection({
            folder: "stream-plugin",
            interceptDomains: ["stream.example"],
            name: "Stream plugin",
        });
        const registrationId = connection.register("request");
        const onEvent = vi.fn(() => true);
        connection.attach(registrationId, onEvent);
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "stream.example", ports: [address.port] }] },
            {
                interceptionBodyTimeoutMs: 10,
                networkInterceptor: registry,
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
        expect(onEvent).not.toHaveBeenCalled();
        expect(failures).toEqual([
            {
                error: "The HTTP request body did not finish within 10ms.",
                pluginFolder: "stream-plugin",
            },
        ]);
    });

    it("fails open without leaking partially applied invalid plugin response headers", async () => {
        const upstream = createHttpServer((_request, response) => {
            response.writeHead(200, { "x-upstream": "clean" }).end("normal response");
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const failures: Array<{ error: string; pluginFolder: string }> = [];
        const registry = new PluginNetworkRegistry({
            onFailure: (failure) =>
                failures.push({
                    error: failure.error,
                    pluginFolder: failure.pluginFolder,
                }),
        });
        const connection = registry.createConnection({
            folder: "headers-plugin",
            interceptDomains: ["headers.example"],
            name: "Headers plugin",
        });
        const registrationId = connection.register("request");
        connection.attach(registrationId, (event) => {
            if (event.type === "request" && event.mode === "handle") {
                connection.complete(registrationId, event.callId, {
                    headers: {
                        "x-plugin": "must-not-leak",
                        "x-invalid": "line one\nline two",
                    },
                    status: 201,
                    type: "response",
                });
            }
            return true;
        });
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "headers.example", ports: [address.port] }] },
            {
                networkInterceptor: registry,
                resolveAddress: async () => "127.0.0.1",
            },
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
        expect(failures[0]).toMatchObject({ pluginFolder: "headers-plugin" });
    });

    it("fails open to the original request when plugin rewrite headers are invalid", async () => {
        const received: Array<{
            body: string;
            method: string | undefined;
            originalHeader: string | undefined;
            url: string | undefined;
        }> = [];
        const upstream = createHttpServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            received.push({
                body: Buffer.concat(chunks).toString("utf8"),
                method: request.method,
                originalHeader: request.headers["x-original"] as string | undefined,
                url: request.url,
            });
            response.end("original forwarded");
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        closeables.push({
            close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
        });
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("Missing HTTP port.");
        const failures: Array<{ error: string; pluginFolder: string }> = [];
        const registry = new PluginNetworkRegistry({
            onFailure: (failure) =>
                failures.push({
                    error: failure.error,
                    pluginFolder: failure.pluginFolder,
                }),
        });
        const connection = registry.createConnection({
            folder: "rewrite-headers-plugin",
            interceptDomains: ["rewrite-headers.example"],
            name: "Rewrite headers plugin",
        });
        const registrationId = connection.register("request");
        connection.attach(registrationId, (event) => {
            if (event.type === "request" && event.mode === "handle") {
                connection.complete(registrationId, event.callId, {
                    bodyBase64: Buffer.from("changed body").toString("base64"),
                    headers: { "x-invalid": "line one\nline two" },
                    method: "PUT",
                    type: "request",
                    url: `http://rewrite-headers.example:${String(address.port)}/changed`,
                });
            }
            return true;
        });
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            {
                allowedDomains: [{ domain: "rewrite-headers.example", ports: [address.port] }],
            },
            {
                networkInterceptor: registry,
                resolveAddress: async () => "127.0.0.1",
            },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(
            proxy.port,
            `http://rewrite-headers.example:${String(address.port)}/original`,
            {
                body: "original body",
                headers: { "x-original": "preserved" },
                method: "POST",
            },
        );

        expect(response.body).toBe("original forwarded");
        expect(received).toEqual([
            {
                body: "original body",
                method: "POST",
                originalHeader: "preserved",
                url: "/original",
            },
        ]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ pluginFolder: "rewrite-headers-plugin" });
    });

    it("does not let a plugin declaration make a policy-blocked domain reachable", async () => {
        const onEvent = vi.fn(() => true);
        const resolveAddress = vi.fn(async () => "127.0.0.1");
        const registry = new PluginNetworkRegistry();
        const connection = registry.createConnection({
            folder: "blocked-plugin",
            interceptDomains: ["blocked.example"],
            name: "Blocked plugin",
        });
        const registrationId = connection.register("request");
        connection.attach(registrationId, onEvent);
        closeables.push({ close: () => registry.close() });
        const proxy = await startManagedNetworkProxy(
            { allowedDomains: [{ domain: "allowed.example", ports: [80] }] },
            { networkInterceptor: registry, resolveAddress },
        );
        closeables.push(proxy);

        const response = await requestThroughProxy(proxy.port, "http://blocked.example/");

        expect(response.status).toBe(403);
        expect(response.body).toBe("Domain not in allowlist.");
        expect(onEvent).not.toHaveBeenCalled();
        expect(resolveAddress).not.toHaveBeenCalled();
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

function networkHandler(
    domains: readonly string[],
    onEvent: (
        event: HappyNetworkEvent,
        connection: ReturnType<PluginNetworkRegistry["createConnection"]>,
        registrationId: string,
    ) => void,
) {
    const registry = new PluginNetworkRegistry();
    const connection = registry.createConnection({
        folder: "test-plugin",
        interceptDomains: domains,
        name: "Test plugin",
    });
    const registrationId = connection.register("request");
    connection.attach(registrationId, (event) => {
        onEvent(event, connection, registrationId);
        return true;
    });
    return { connection, registrationId, registry };
}

function requestThroughProxy(
    proxyPort: number,
    target: string,
    options: {
        body?: string;
        headers?: Readonly<Record<string, string>>;
        method?: string;
    } = {},
): Promise<{
    body: string;
    headers: import("node:http").IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: {
                    ...options.headers,
                    ...(options.body === undefined
                        ? {}
                        : { "content-length": Buffer.byteLength(options.body) }),
                },
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
