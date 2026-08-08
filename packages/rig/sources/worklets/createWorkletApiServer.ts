import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { errorToMessage } from "../errorToMessage.js";
import { isAuthorizedProtocolRequest } from "../server/isAuthorizedProtocolRequest.js";
import { sendJson } from "../server/sendJson.js";
import type { WorkletStartupState } from "./WorkletStartupState.js";
import type { WorkletToolConnection } from "./WorkletToolRegistry.js";
import {
    registerWorkletToolsRequestSchema,
    workletCallCompletionSchema,
    workletReadyRequestSchema,
    workletStatusRequestSchema,
} from "./workletWire.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

/** A request the worklet got wrong, as opposed to a failure inside Rig. */
class WorkletRequestError extends Error {}

export interface CreateWorkletApiServerOptions {
    onReady?: () => void;
    onStatus?: (status: string) => void;
    startup: WorkletStartupState;
    token: string;
    tools: WorkletToolConnection;
}

/**
 * The private socket a worklet talks to Rig through.
 *
 * Everything a worklet can do today goes through it: declaring tools, answering the calls Rig
 * streams back, reporting ready, and saying what it is doing. The token is what authorizes the
 * socket; nothing else is trusted.
 */
export function createWorkletApiServer(options: CreateWorkletApiServerOptions): Server {
    return createServer((request, response) => {
        if (!isAuthorizedProtocolRequest(request, options.token)) {
            sendJson(response, 401, { error: "This worklet connection is not authorized." });
            return;
        }
        void handleRequest(request, response, options).catch((error: unknown) => {
            sendJson(response, error instanceof WorkletRequestError ? 400 : 500, {
                error: errorToMessage(error),
            });
        });
    });
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: CreateWorkletApiServerOptions,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://worklet.local");
    const parts = url.pathname.split("/").filter((part) => part.length > 0);

    if (request.method === "POST" && url.pathname === "/tools") {
        assertStarting(options, "Tool registration");
        const registration = await readJson(
            request,
            registerWorkletToolsRequestSchema,
            "The worklet tool registration",
        );
        sendJson(response, 201, { registrationId: options.tools.register(registration.tools) });
        return;
    }

    if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "tools" &&
        parts[1] !== undefined &&
        parts[2] === "events"
    ) {
        assertStarting(options, "Tool stream attachment");
        const detach = options.tools.attach(parts[1], (event) => {
            if (response.destroyed || response.writableEnded) return false;
            return response.write(`${JSON.stringify(event)}\n`);
        });
        response.once("close", detach);
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson",
        });
        response.flushHeaders();
        return;
    }

    if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "tools" &&
        parts[1] !== undefined &&
        parts[2] === "calls" &&
        parts[3] !== undefined
    ) {
        const completion = await readJson(
            request,
            workletCallCompletionSchema,
            "The worklet tool result",
        );
        options.tools.complete(parts[1], parts[3], completion);
        sendJson(response, 200, {});
        return;
    }

    if (request.method === "POST" && url.pathname === "/ready") {
        const body = await readJson(request, workletReadyRequestSchema, "The worklet ready report");
        options.startup.ready();
        if (body.status !== undefined) options.onStatus?.(body.status);
        options.onReady?.();
        sendJson(response, 200, {});
        return;
    }

    if (request.method === "POST" && url.pathname === "/status") {
        const body = await readJson(request, workletStatusRequestSchema, "The worklet status");
        options.startup.assertActive("A worklet status");
        options.onStatus?.(body.status);
        sendJson(response, 200, {});
        return;
    }

    sendJson(response, 404, { error: "That worklet API route does not exist." });
}

function assertStarting(options: CreateWorkletApiServerOptions, contribution: string): void {
    try {
        options.startup.assertStarting(contribution);
    } catch (error) {
        throw new WorkletRequestError(errorToMessage(error));
    }
}

async function readJson<TSchema_ extends TSchema>(
    request: IncomingMessage,
    schema: TSchema_,
    subject: string,
): Promise<Static<TSchema_>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        length += bytes.length;
        if (length > MAX_REQUEST_BYTES) {
            throw new WorkletRequestError("The worklet request is too large.");
        }
        chunks.push(bytes);
    }
    let value: unknown;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new WorkletRequestError("The worklet request is not valid JSON.");
    }
    try {
        return Value.Decode(schema, value);
    } catch {
        const first = Value.Errors(schema, value).First();
        const detail = first === undefined ? "" : ` ${first.path || "value"}: ${first.message}`;
        throw new WorkletRequestError(`${subject} is invalid.${detail}`);
    }
}
