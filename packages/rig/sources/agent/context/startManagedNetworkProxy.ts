import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, isIP } from "node:net";
import { connect } from "node:net";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type {
    ManagedNetworkPolicy,
    ManagedNetworkProxyHandle,
    ManagedNetworkRule,
} from "./ManagedNetworkPolicy.js";

export async function startManagedNetworkProxy(
    policy: ManagedNetworkPolicy,
    options: { resolveAddress?: (host: string) => Promise<string> } = {},
): Promise<ManagedNetworkProxyHandle> {
    validatePolicy(policy);
    const sockets = new Set<{ destroy(): void }>();
    const resolveAddress = options.resolveAddress ?? resolvePublicAddress;
    const server = createServer((incoming, response) => {
        void proxyHttpRequest(incoming, response, policy, sockets, resolveAddress);
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("connect", (incoming, client, head) => {
        sockets.add(client);
        client.once("close", () => sockets.delete(client));
        void proxyConnect(incoming, client, head, policy, sockets, resolveAddress);
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
        server.close();
        throw new Error("Managed network proxy did not bind a TCP port.");
    }
    const socksServer = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        void proxySocksConnection(socket, policy, sockets, resolveAddress);
    });
    await new Promise<void>((resolve, reject) => {
        socksServer.once("error", reject);
        socksServer.listen(0, "127.0.0.1", () => {
            socksServer.off("error", reject);
            resolve();
        });
    });
    const socksAddress = socksServer.address();
    if (socksAddress === null || typeof socksAddress === "string") {
        server.close();
        socksServer.close();
        throw new Error("Managed SOCKS proxy did not bind a TCP port.");
    }
    let closed = false;
    return {
        port: address.port,
        socksPort: socksAddress.port,
        async close() {
            if (closed) return;
            closed = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            await Promise.all([
                new Promise<void>((resolve) => server.close(() => resolve())),
                new Promise<void>((resolve) => socksServer.close(() => resolve())),
            ]);
        },
    };
}

async function proxySocksConnection(
    client: Socket,
    policy: ManagedNetworkPolicy,
    sockets: Set<{ destroy(): void }>,
    resolveAddress: (host: string) => Promise<string>,
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
        if (!isAllowed(policy, host, port)) {
            client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
        }
        const upstream = connect({ host: await resolveAddress(host), port });
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
    resolveAddress: ((host: string) => Promise<string>) | undefined,
): Promise<void> {
    const target = parseAuthority(incoming.url, 443);
    if (target === undefined || !isAllowed(policy, target.host, target.port)) {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
    }
    try {
        const address = await (resolveAddress ?? resolvePublicAddress)(target.host);
        const upstream = connect({ host: address, port: target.port });
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
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) upstream.write(head);
            client.pipe(upstream);
            upstream.pipe(client);
        });
    } catch {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
}

async function proxyHttpRequest(
    incoming: IncomingMessage,
    response: import("node:http").ServerResponse,
    policy: ManagedNetworkPolicy,
    sockets: Set<{ destroy(): void }>,
    resolveAddress: ((host: string) => Promise<string>) | undefined,
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
    if (!isAllowed(policy, target.hostname, port)) {
        response.writeHead(403).end();
        return;
    }
    try {
        const address = await (resolveAddress ?? resolvePublicAddress)(target.hostname);
        const upstream = httpRequest({
            headers: { ...incoming.headers, host: target.host },
            host: address,
            method: incoming.method,
            path: `${target.pathname}${target.search}`,
            port,
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
        incoming.pipe(upstream);
    } catch {
        response.writeHead(403).end();
    }
}

function isAllowed(policy: ManagedNetworkPolicy, host: string, port: number): boolean {
    const normalizedHost = normalizeDomain(host);
    if (policy.deniedDomains?.some((rule) => matchesRule(rule, normalizedHost, port)) === true) {
        return false;
    }
    return policy.allowedDomains?.some((rule) => matchesRule(rule, normalizedHost, port)) === true;
}

function matchesRule(rule: ManagedNetworkRule, host: string, port: number): boolean {
    const pattern = normalizeDomain(rule.domain);
    const domainMatches =
        pattern.startsWith("*.") &&
        host.length > pattern.length - 1 &&
        host.endsWith(pattern.slice(1))
            ? true
            : host === pattern;
    return domainMatches && (rule.ports === undefined || rule.ports.includes(port));
}

function validatePolicy(policy: ManagedNetworkPolicy): void {
    if ((policy.allowedDomains?.length ?? 0) === 0) {
        throw new Error("Managed network access requires at least one allowed domain.");
    }
    for (const rule of [...(policy.allowedDomains ?? []), ...(policy.deniedDomains ?? [])]) {
        const domain = normalizeDomain(rule.domain);
        if (
            domain.length === 0 ||
            domain.includes("/") ||
            domain.includes(":") ||
            (domain.includes("*") && (!domain.startsWith("*.") || domain.slice(2).includes("*")))
        ) {
            throw new Error(`Invalid managed network domain pattern: ${rule.domain}`);
        }
        for (const port of rule.ports ?? []) {
            if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
                throw new Error(`Invalid managed network port: ${String(port)}`);
            }
        }
    }
}

async function resolvePublicAddress(host: string): Promise<string> {
    if (host === "localhost") throw new Error("Managed external network cannot target localhost.");
    const addresses =
        isIP(host) === 0 ? await lookup(host, { all: true, verbatim: true }) : [{ address: host }];
    const publicAddress = addresses.find(({ address }) => !isNonPublicAddress(address));
    if (
        publicAddress === undefined ||
        addresses.some(({ address }) => isNonPublicAddress(address))
    ) {
        throw new Error("Managed external network target resolved to a non-public address.");
    }
    return publicAddress.address;
}

function isNonPublicAddress(address: string): boolean {
    if (address.includes(":")) {
        const value = address.toLowerCase();
        if (value.startsWith("::ffff:")) return isNonPublicAddress(value.slice("::ffff:".length));
        return (
            value === "::" ||
            value === "::1" ||
            value.startsWith("fc") ||
            value.startsWith("fd") ||
            value.startsWith("fe8") ||
            value.startsWith("fe9") ||
            value.startsWith("fea") ||
            value.startsWith("feb")
        );
    }
    const octets = address.split(".").map(Number);
    return (
        octets[0] === 0 ||
        octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
        (octets[0] ?? 0) >= 224
    );
}

function normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase().replace(/\.$/u, "");
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
