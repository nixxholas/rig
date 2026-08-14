import {
    createServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    validateHeaderName,
    validateHeaderValue,
} from "node:http";
import { createServer as createTcpServer } from "node:net";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { PassThrough, type Duplex, type Readable } from "node:stream";
import { Value } from "@sinclair/typebox/value";
import {
    createBoundedEgressResolver,
    egressResolutionBlockedReason,
    resolveAnyEgressAddress,
    resolvePublicEgressAddress,
} from "./impl/resolveEgressAddress.js";
import {
    egressBlockReason,
    normalizeEgressDomain,
    validateEgressRules,
} from "./impl/egressPolicyRules.js";
import {
    MANAGED_NETWORK_MAX_BODY_BYTES,
    managedNetworkRequestCompletionSchema,
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkPolicy,
    type ManagedNetworkProxyHandle,
    type ManagedNetworkInterceptor,
} from "./ManagedNetworkPolicy.js";

const DEFAULT_DNS_RESOLUTION_TIMEOUT_MS = 2_000;
const DEFAULT_INTERCEPTION_BODY_TIMEOUT_MS = 5_000;

export async function startManagedNetworkProxy(
    policy: ManagedNetworkPolicy,
    options: {
        connectUpstream?: (options: { host: string; port: number }) => Socket;
        interceptionBodyTimeoutMs?: number;
        onHttpListening?: (port: number) => void;
        networkInterceptor?: ManagedNetworkInterceptor;
        resolveAddress?: (host: string) => Promise<string>;
        resolveTimeoutMs?: number;
        socksPort?: number;
    } = {},
): Promise<ManagedNetworkProxyHandle> {
    validateEgressRules(policy);
    const sockets = new Set<{ destroy(): void }>();
    const resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_DNS_RESOLUTION_TIMEOUT_MS;
    if (!Number.isSafeInteger(resolveTimeoutMs) || resolveTimeoutMs < 1) {
        throw new Error("Managed network DNS resolution timeout must be a positive integer.");
    }
    const interceptionBodyTimeoutMs =
        options.interceptionBodyTimeoutMs ?? DEFAULT_INTERCEPTION_BODY_TIMEOUT_MS;
    if (!Number.isSafeInteger(interceptionBodyTimeoutMs) || interceptionBodyTimeoutMs < 1) {
        throw new Error("Plugin interception body timeout must be a positive integer.");
    }
    const resolveAddress = createBoundedEgressResolver(
        options.resolveAddress ??
            (policy.allowPrivateAddresses === true
                ? resolveAnyEgressAddress
                : resolvePublicEgressAddress),
        resolveTimeoutMs,
    );
    const connectUpstream = options.connectUpstream ?? ((target) => connect(target));
    const lifecycle = new AbortController();
    let blockedRequest: ManagedNetworkBlockedRequest | undefined;
    const blockedRequestListeners = new Set<(request: ManagedNetworkBlockedRequest) => void>();
    const recordBlockedRequest = (request: ManagedNetworkBlockedRequest) => {
        if (blockedRequest !== undefined) return;
        blockedRequest = request;
        for (const listener of blockedRequestListeners) {
            try {
                listener(request);
            } catch {
                // The HTTP/SOCKS policy response must not depend on an optional command observer.
            }
        }
    };
    const server = createServer((incoming, response) => {
        void proxyHttpRequest(
            incoming,
            response,
            policy,
            sockets,
            resolveAddress,
            lifecycle.signal,
            recordBlockedRequest,
            options.networkInterceptor,
            interceptionBodyTimeoutMs,
        );
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("connect", (incoming, client, head) => {
        sockets.add(client);
        client.once("close", () => sockets.delete(client));
        void proxyConnect(
            incoming,
            client,
            head,
            policy,
            sockets,
            resolveAddress,
            connectUpstream,
            lifecycle.signal,
            recordBlockedRequest,
            options.networkInterceptor,
        );
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        await closeServer(server);
        throw new Error("Managed network proxy did not bind a TCP port.");
    }
    const socksServer = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        void proxySocksConnection(
            socket,
            policy,
            sockets,
            resolveAddress,
            connectUpstream,
            lifecycle.signal,
            recordBlockedRequest,
        );
    });
    try {
        options.onHttpListening?.(address.port);
        await new Promise<void>((resolve, reject) => {
            socksServer.once("error", reject);
            socksServer.listen(options.socksPort ?? 0, "127.0.0.1", () => {
                socksServer.off("error", reject);
                resolve();
            });
        });
        const socksAddress = socksServer.address();
        if (socksAddress === null || typeof socksAddress === "string") {
            throw new Error("Managed SOCKS proxy did not bind a TCP port.");
        }
        let closed = false;
        return {
            blockedRequest: () => blockedRequest,
            port: address.port,
            socksPort: socksAddress.port,
            onBlockedRequest(listener) {
                blockedRequestListeners.add(listener);
                if (blockedRequest !== undefined) {
                    try {
                        listener(blockedRequest);
                    } catch {
                        // The recorded denial remains authoritative even if an observer is broken.
                    }
                }
                return () => blockedRequestListeners.delete(listener);
            },
            async close() {
                if (closed) return;
                closed = true;
                lifecycle.abort();
                blockedRequestListeners.clear();
                for (const socket of sockets) socket.destroy();
                sockets.clear();
                await Promise.all([closeServer(server), closeServer(socksServer)]);
            },
        };
    } catch (error) {
        lifecycle.abort();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await Promise.all([closeServer(server), closeServer(socksServer)]);
        throw error;
    }
}

async function closeServer(
    server: import("node:http").Server | import("node:net").Server,
): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function proxySocksConnection(
    client: Socket,
    policy: ManagedNetworkPolicy,
    sockets: Set<{ destroy(): void }>,
    resolveAddress: (host: string) => Promise<string>,
    connectUpstream: (options: { host: string; port: number }) => Socket,
    signal: AbortSignal,
    recordBlockedRequest: (request: ManagedNetworkBlockedRequest) => void,
): Promise<void> {
    try {
        const greeting = await readSocketBytes(client, 2);
        if (greeting[0] !== 5) throw new Error("Unsupported SOCKS version.");
        await readSocketBytes(client, greeting[1] ?? 0);
        client.write(Buffer.from([5, 0]));
        const request = await readSocketBytes(client, 4);
        if (request[0] !== 5 || request[1] !== 1) throw new Error("Unsupported SOCKS command.");
        const addressType = request[3];
        let host: string;
        if (addressType === 1) {
            host = [...(await readSocketBytes(client, 4))].join(".");
        } else if (addressType === 3) {
            const length = (await readSocketBytes(client, 1))[0] ?? 0;
            host = (await readSocketBytes(client, length)).toString("utf8");
        } else {
            throw new Error("Unsupported SOCKS address type.");
        }
        const portBytes = await readSocketBytes(client, 2);
        const port = portBytes.readUInt16BE(0);
        const blockedReason = egressBlockReason(policy, host, port);
        if (blockedReason !== undefined) {
            recordBlockedRequest({
                host: normalizeEgressDomain(host),
                port,
                protocol: "socks5",
                reason: blockedReason,
            });
            client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
        }
        let address: string;
        try {
            address = await resolveAddressWhileOpen(host, resolveAddress, signal);
        } catch (error) {
            const reason = egressResolutionBlockedReason(error);
            if (reason !== undefined) {
                recordBlockedRequest({
                    host: normalizeEgressDomain(host),
                    port,
                    protocol: "socks5",
                    reason,
                });
                client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
                return;
            }
            throw error;
        }
        const upstream = connectUpstream({
            host: address,
            port,
        });
        sockets.add(upstream);
        upstream.on("error", () => client.destroy());
        upstream.once("close", () => sockets.delete(upstream));
        client.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
        });
    } catch {
        if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
}

async function readSocketBytes(socket: Socket, length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    let buffered = socket.read(length) as Buffer | null;
    while (buffered === null) {
        await new Promise<void>((resolve, reject) => {
            socket.once("readable", resolve);
            socket.once("error", reject);
            socket.once("close", reject);
        });
        buffered = socket.read(length) as Buffer | null;
    }
    return buffered;
}

async function proxyConnect(
    incoming: IncomingMessage,
    client: Duplex,
    head: Buffer,
    policy: ManagedNetworkPolicy,
    sockets: Set<{ destroy(): void }>,
    resolveAddress: (host: string) => Promise<string>,
    connectUpstream: (options: { host: string; port: number }) => Socket,
    signal: AbortSignal,
    recordBlockedRequest: (request: ManagedNetworkBlockedRequest) => void,
    networkInterceptor?: ManagedNetworkInterceptor,
): Promise<void> {
    // CONNECT exposes only the authority. The proxy does not mint certificates or unwrap
    // TLS, so plugins receive byte-count observations after the opaque tunnel closes.
    const target = parseAuthority(incoming.url, 443);
    if (target === undefined) {
        client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
    }
    const blockedReason = egressBlockReason(policy, target.host, target.port);
    if (blockedReason !== undefined) {
        recordBlockedRequest({
            host: normalizeEgressDomain(target.host),
            port: target.port,
            protocol: "https_connect",
            reason: blockedReason,
        });
        writeConnectBlocked(client, blockedReason);
        return;
    }
    try {
        const address = await resolveAddressWhileOpen(target.host, resolveAddress, signal);
        const upstream = connectUpstream({ host: address, port: target.port });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        client.once("close", () => upstream.destroy());
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => {
            if (!client.destroyed) {
                client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            }
            upstream.destroy();
        });
        upstream.once("connect", () => {
            let bytesFromClient = head.length;
            let bytesFromServer = 0;
            let observed = false;
            const observe = () => {
                if (observed) return;
                observed = true;
                try {
                    networkInterceptor?.observeTunnel({
                        bytesFromClient,
                        bytesFromServer,
                        hostname: normalizeEgressDomain(target.host),
                        port: target.port,
                        type: "tunnel",
                    });
                } catch (error) {
                    if (networkInterceptor !== undefined) {
                        recordInterceptorFailure(networkInterceptor, target.host, error);
                    }
                }
            };
            client.on("data", (chunk: Buffer | string) => {
                bytesFromClient += Buffer.byteLength(chunk);
            });
            upstream.on("data", (chunk: Buffer | string) => {
                bytesFromServer += Buffer.byteLength(chunk);
            });
            upstream.once("close", observe);
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) upstream.write(head);
            client.pipe(upstream);
            upstream.pipe(client);
        });
    } catch (error) {
        if (!client.destroyed) {
            const reason = egressResolutionBlockedReason(error);
            if (reason !== undefined) {
                recordBlockedRequest({
                    host: normalizeEgressDomain(target.host),
                    port: target.port,
                    protocol: "https_connect",
                    reason,
                });
                writeConnectBlocked(client, reason);
            } else {
                client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
            }
        }
    }
}

async function proxyHttpRequest(
    incoming: IncomingMessage,
    response: import("node:http").ServerResponse,
    policy: ManagedNetworkPolicy,
    sockets: Set<{ destroy(): void }>,
    resolveAddress: (host: string) => Promise<string>,
    signal: AbortSignal,
    recordBlockedRequest: (request: ManagedNetworkBlockedRequest) => void,
    networkInterceptor?: ManagedNetworkInterceptor,
    interceptionBodyTimeoutMs = DEFAULT_INTERCEPTION_BODY_TIMEOUT_MS,
): Promise<void> {
    let target: URL;
    try {
        target = new URL(incoming.url ?? "");
    } catch {
        response.writeHead(400).end();
        return;
    }
    if (target.protocol !== "http:") {
        response.writeHead(400).end();
        return;
    }
    const port = target.port === "" ? 80 : Number(target.port);
    const blockedReason = egressBlockReason(policy, target.hostname, port);
    if (blockedReason !== undefined) {
        recordBlockedRequest({
            host: normalizeEgressDomain(target.hostname),
            port,
            protocol: "http",
            reason: blockedReason,
        });
        writeHttpBlocked(response, blockedReason);
        return;
    }
    let requestTarget = target;
    let requestMethod = incoming.method ?? "GET";
    let requestHeaders: IncomingHttpHeaders = { ...incoming.headers };
    let requestBody: Buffer | Readable = incoming;
    const normalizedHostname = normalizeEgressDomain(target.hostname);
    let shouldIntercept = false;
    if (networkInterceptor !== undefined) {
        try {
            shouldIntercept = networkInterceptor.shouldIntercept(normalizedHostname);
        } catch (error) {
            recordInterceptorFailure(networkInterceptor, normalizedHostname, error);
        }
    }
    if (networkInterceptor !== undefined && shouldIntercept) {
        const captured = await readInterceptionBody(incoming, interceptionBodyTimeoutMs);
        if ("stream" in captured) {
            requestBody = captured.stream;
            recordInterceptorFailure(
                networkInterceptor,
                normalizedHostname,
                new Error(
                    captured.reason === "too_large"
                        ? `The HTTP request body exceeded ${String(MANAGED_NETWORK_MAX_BODY_BYTES)} bytes.`
                        : `The HTTP request body did not finish within ${String(interceptionBodyTimeoutMs)}ms.`,
                ),
            );
        } else {
            const buffered = captured.body;
            requestBody = buffered;
            try {
                const action = Value.Decode(
                    managedNetworkRequestCompletionSchema,
                    await networkInterceptor.interceptHttp({
                        body: buffered,
                        headers: normalizeHeaders(incoming.headers),
                        hostname: normalizedHostname,
                        method: requestMethod,
                        url: target.toString(),
                    }),
                );
                if (action.type === "error") {
                    throw new Error(`The plugin network handler failed: ${action.error}`);
                }
                if (action.type === "response") {
                    const body = decodeBoundedPluginBody(action.bodyBase64);
                    const headers = action.headers ?? {};
                    validatePluginHeaders(headers);
                    response.writeHead(action.status, headers);
                    response.end(body);
                    return;
                }
                if (action.type === "request") {
                    if (action.headers !== undefined) validatePluginHeaders(action.headers);
                    requestTarget = action.url === undefined ? target : parseHttpTarget(action.url);
                    requestMethod = action.method ?? requestMethod;
                    requestHeaders = action.headers ?? requestHeaders;
                    if (action.bodyBase64 !== undefined) {
                        requestBody = decodeBoundedPluginBody(action.bodyBase64);
                        requestHeaders = {
                            ...requestHeaders,
                            "content-length": String(requestBody.length),
                        };
                        delete requestHeaders["transfer-encoding"];
                    }
                    const rewrittenPort =
                        requestTarget.port === "" ? 80 : Number(requestTarget.port);
                    const rewrittenBlock = egressBlockReason(
                        policy,
                        requestTarget.hostname,
                        rewrittenPort,
                    );
                    if (rewrittenBlock !== undefined) {
                        recordBlockedRequest({
                            host: normalizeEgressDomain(requestTarget.hostname),
                            port: rewrittenPort,
                            protocol: "http",
                            reason: rewrittenBlock,
                        });
                        writeHttpBlocked(response, rewrittenBlock);
                        return;
                    }
                }
            } catch (error) {
                recordInterceptorFailure(networkInterceptor, normalizedHostname, error);
                requestTarget = target;
                requestMethod = incoming.method ?? "GET";
                requestHeaders = { ...incoming.headers };
                requestBody = buffered;
            }
        }
    }
    const requestPort = requestTarget.port === "" ? 80 : Number(requestTarget.port);
    try {
        const address = await resolveAddressWhileOpen(
            requestTarget.hostname,
            resolveAddress,
            signal,
        );
        const upstream = httpRequest({
            headers: { ...requestHeaders, host: requestTarget.host },
            host: address,
            method: requestMethod,
            path: `${requestTarget.pathname}${requestTarget.search}`,
            port: requestPort,
        });
        upstream.on("socket", (socket) => socket.on("error", () => {}));
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.once("response", (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
        });
        upstream.once("error", () => {
            if (!response.headersSent) response.writeHead(502);
            response.end();
        });
        if (Buffer.isBuffer(requestBody)) upstream.end(requestBody);
        else requestBody.pipe(upstream);
    } catch (error) {
        if (!response.destroyed) {
            const reason = egressResolutionBlockedReason(error);
            if (reason !== undefined) {
                recordBlockedRequest({
                    host: normalizeEgressDomain(requestTarget.hostname),
                    port: requestPort,
                    protocol: "http",
                    reason,
                });
                writeHttpBlocked(response, reason);
            } else {
                response.writeHead(502).end();
            }
        }
    }
}

async function readInterceptionBody(
    incoming: IncomingMessage,
    timeoutMs: number,
): Promise<{ body: Buffer } | { reason: "timeout" | "too_large"; stream: Readable }> {
    const contentLength = Number(incoming.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MANAGED_NETWORK_MAX_BODY_BYTES) {
        return { reason: "too_large", stream: incoming };
    }
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let length = 0;
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            incoming.off("data", onData);
            incoming.off("end", onEnd);
            incoming.off("error", onError);
        };
        const finishWithStream = (reason: "timeout" | "too_large") => {
            if (settled) return;
            settled = true;
            incoming.pause();
            cleanup();
            const replay = new PassThrough();
            for (const buffered of chunks) replay.write(buffered);
            incoming.pipe(replay);
            incoming.resume();
            resolve({ reason, stream: replay });
        };
        const onData = (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += bytes.length;
            if (length <= MANAGED_NETWORK_MAX_BODY_BYTES) {
                chunks.push(bytes);
                return;
            }
            chunks.push(bytes);
            finishWithStream("too_large");
        };
        const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ body: Buffer.concat(chunks) });
        };
        const onError = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const timer = setTimeout(() => finishWithStream("timeout"), timeoutMs);
        timer.unref();
        incoming.on("data", onData);
        incoming.once("end", onEnd);
        incoming.once("error", onError);
    });
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
    return Object.fromEntries(
        Object.entries(headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]],
        ),
    );
}

function parseHttpTarget(value: string): URL {
    const target = new URL(value);
    if (target.protocol !== "http:" || target.username !== "" || target.password !== "") {
        throw new Error("A plugin may rewrite a managed proxy request only to an HTTP URL.");
    }
    const port = target.port === "" ? 80 : Number(target.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("A plugin returned an invalid HTTP request port.");
    }
    return target;
}

function decodeBoundedPluginBody(value: string | undefined): Buffer {
    if (value === undefined) return Buffer.alloc(0);
    const body = Buffer.from(value, "base64");
    if (body.length > MANAGED_NETWORK_MAX_BODY_BYTES) {
        throw new Error(
            `A plugin network body exceeded ${String(MANAGED_NETWORK_MAX_BODY_BYTES)} bytes.`,
        );
    }
    return body;
}

function validatePluginHeaders(
    headers: Readonly<Record<string, string | readonly string[]>>,
): void {
    for (const [name, value] of Object.entries(headers)) {
        validateHeaderName(name);
        for (const item of typeof value === "string" ? [value] : value) {
            validateHeaderValue(name, item);
        }
    }
}

function recordInterceptorFailure(
    interceptor: ManagedNetworkInterceptor,
    hostname: string,
    error: unknown,
): void {
    try {
        interceptor.recordFailure(hostname, error);
    } catch {
        // Logging is optional; it must never replace the normal proxy path.
    }
}

async function resolveAddressWhileOpen(
    host: string,
    resolveAddress: (host: string) => Promise<string>,
    signal: AbortSignal,
): Promise<string> {
    if (signal.aborted) throw new Error("Managed network proxy is closed.");
    const address = await resolveAddress(host);
    if (signal.aborted) throw new Error("Managed network proxy is closed.");
    return address;
}

function writeConnectBlocked(client: Duplex, reason: ManagedNetworkBlockedRequest["reason"]): void {
    const body = blockedMessage(reason);
    client.end(
        [
            "HTTP/1.1 403 Forbidden",
            "Connection: close",
            "Content-Type: text/plain",
            `Content-Length: ${String(Buffer.byteLength(body))}`,
            `X-Proxy-Error: ${blockedHeader(reason)}`,
            "",
            body,
        ].join("\r\n"),
    );
}

function writeHttpBlocked(
    response: import("node:http").ServerResponse,
    reason: ManagedNetworkBlockedRequest["reason"],
): void {
    response
        .writeHead(403, {
            "content-type": "text/plain",
            "x-proxy-error": blockedHeader(reason),
        })
        .end(blockedMessage(reason));
}

function blockedHeader(reason: ManagedNetworkBlockedRequest["reason"]): string {
    if (reason === "not_allowed") return "blocked-by-allowlist";
    if (reason === "denied") return "blocked-by-denylist";
    if (reason === "dns_resolution_failed") return "blocked-dns-resolution";
    return "blocked-private-address";
}

function blockedMessage(reason: ManagedNetworkBlockedRequest["reason"]): string {
    if (reason === "not_allowed") return "Domain not in allowlist.";
    if (reason === "denied") return "Domain denied by the sandbox policy.";
    if (reason === "dns_resolution_failed") {
        return "DNS resolution failed or exceeded the sandbox policy timeout.";
    }
    return "Sandbox policy blocks local or private network addresses.";
}

function parseAuthority(
    value: string | undefined,
    defaultPort: number,
): { host: string; port: number } | undefined {
    if (value === undefined) return undefined;
    try {
        const target = new URL(`http://${value}`);
        const port = target.port === "" ? defaultPort : Number(target.port);
        if (
            target.username !== "" ||
            target.password !== "" ||
            target.pathname !== "/" ||
            !Number.isSafeInteger(port) ||
            port < 1 ||
            port > 65_535
        ) {
            return undefined;
        }
        return { host: target.hostname, port };
    } catch {
        return undefined;
    }
}
