import {
    request as requestHttp,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { request as requestHttps } from "node:https";

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

export function proxyHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    let target: URL;
    try {
        target = new URL(request.url ?? "");
    } catch {
        response.writeHead(400);
        response.end("Invalid proxy target.");
        return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        response.writeHead(400);
        response.end("Unsupported proxy protocol.");
        return;
    }

    const headers = forwardedHeaders(request.headers);
    headers.host = target.host;
    const upstream = (target.protocol === "https:" ? requestHttps : requestHttp)(
        target,
        {
            headers,
            method: request.method,
        },
        (upstreamResponse) => {
            response.writeHead(
                upstreamResponse.statusCode ?? 502,
                forwardedHeaders(upstreamResponse.headers),
            );
            upstreamResponse.pipe(response);
        },
    );
    upstream.once("error", (error) => {
        if (!response.headersSent) response.writeHead(502);
        response.end(error.message);
    });
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
    const omitted = new Set(HOP_BY_HOP_HEADERS);
    for (const value of arrayOf(headers.connection)) {
        for (const name of value.split(",")) omitted.add(name.trim().toLowerCase());
    }
    const forwarded: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || omitted.has(name.toLowerCase())) continue;
        forwarded[name] = typeof value === "number" ? String(value) : value;
    }
    return forwarded;
}

function arrayOf(value: string | string[] | undefined): string[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
