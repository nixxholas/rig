import type { IncomingMessage } from "node:http";

import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

import { AgentHttpError } from "./errors.js";

export const MAX_AGENT_HTTP_BODY_BYTES = 12 * 1_024 * 1_024;

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const declaredLength = request.headers["content-length"];
    if (typeof declaredLength === "string") {
        const parsedLength = Number(declaredLength);
        if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_AGENT_HTTP_BODY_BYTES) {
            request.resume();
            throw new AgentHttpError(413, "Request body is too large.");
        }
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_AGENT_HTTP_BODY_BYTES) {
            request.resume();
            throw new AgentHttpError(413, "Request body is too large.");
        }
        chunks.push(buffer);
    }
    if (bytes === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new AgentHttpError(400, "Request body must be valid JSON.");
    }
}

export async function readValidatedBody<Schema extends TSchema>(
    request: IncomingMessage,
    schema: Schema,
): Promise<Static<Schema>> {
    const value = await readJsonBody(request);
    if (!Value.Check(schema, value)) {
        throw new AgentHttpError(400, describeInvalidBody(schema, value));
    }
    return value as Static<Schema>;
}

/**
 * Names the field that failed. A caller reading "Request body is invalid." on its own has to guess
 * which of a dozen fields the daemon refused, so the first failure is spelled out instead.
 */
function describeInvalidBody(schema: TSchema, value: unknown): string {
    const first = Value.Errors(schema, value).First();
    if (first === undefined) return "Request body is invalid.";
    const field =
        first.path === "" ? "the request body" : `"${first.path.slice(1).replaceAll("/", ".")}"`;
    return `Request body is invalid: ${first.message} at ${field}.`;
}

export function parsePositiveLimit(
    value: string | null,
    defaultValue: number,
    maximum: number,
): number {
    if (value === null) return defaultValue;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new AgentHttpError(400, "The limit must be a positive integer.");
    }
    return Math.min(parsed, maximum);
}
