import type { ServerResponse } from "node:http";

export class AgentHttpError extends Error {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly details: unknown;

    constructor(
        status: number,
        message: string,
        details?: unknown,
        headers: Readonly<Record<string, string>> = {},
    ) {
        super(message);
        this.name = "AgentHttpError";
        this.status = status;
        this.headers = headers;
        this.details = details;
    }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const content = serializeJson(body);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(content).toString(),
        "content-type": "application/json; charset=utf-8",
    });
    response.end(content);
}

export function sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
    }
    if (error instanceof AgentHttpError) {
        const details = asObject(error.details);
        sendJson(
            response,
            error.status,
            error.details === undefined
                ? { error: error.message }
                : { ...details, error: error.message },
        );
        return;
    }
    sendJson(response, 500, { error: errorMessage(error) });
}

export function errorMessage(error: unknown): string {
    if (!(error instanceof Error)) return "The Happy agent request failed.";
    // Do not expose filesystem paths, tokens, or provider diagnostics through an unexpected
    // HTTP failure. Route handlers should throw AgentHttpError when a detail is safe to expose.
    return "The Happy agent request failed.";
}

export function serializeJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "bigint") return item.toString();
        if (item instanceof Error) return { message: item.message, name: item.name };
        return item;
    });
}

function asObject(value: unknown): Record<string, unknown> {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { details: value };
}
