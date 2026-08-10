import type { RequestListener } from "node:http";

import type { Context } from "@steve.kite/stdlib";

import {
    RIG_PROTOCOL_VERSION,
    type DaemonIdentity,
    type HealthResponse,
    type ShutdownServerResponse,
} from "../protocol/index.js";
import { spanTraceId, withRequestContext } from "../observability/index.js";
import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";
import { sendJson } from "./sendJson.js";

export interface DaemonStartupState {
    error?: string;
    status: "error" | "starting";
}

export interface CreateDaemonStartupRequestListenerOptions {
    getState: () => DaemonStartupState;
    identity: DaemonIdentity;
    onShutdown: () => void;
    token: string;
}

export function createDaemonStartupRequestListener(
    _ctx: Context,
    options: CreateDaemonStartupRequestListenerOptions,
): RequestListener {
    return (request, response) => {
        const url = new URL(request.url ?? "/", "http://unix");
        const routeName = startupRouteName(url.pathname);
        void withRequestContext(
            routeName,
            {
                method: request.method ?? "UNKNOWN",
                route: routeName,
            },
            async (ctx) => {
                const traceId = spanTraceId(ctx);
                if (traceId !== undefined) response.setHeader("x-rig-trace-id", traceId);
                handleStartupRequest(ctx, request, response, options, url);
            },
        );
    };
}

function handleStartupRequest(
    ctx: Context,
    request: Parameters<RequestListener>[0],
    response: Parameters<RequestListener>[1],
    options: CreateDaemonStartupRequestListenerOptions,
    url: URL,
): void {
    ctx.log.debug("Handling daemon startup request.");
    if (!isAuthorizedProtocolRequest(request, options.token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
        const state = options.getState();
        const health: HealthResponse =
            state.status === "error"
                ? {
                      error: state.error ?? "The local daemon could not start.",
                      healthy: false,
                      identity: options.identity,
                      protocolVersion: RIG_PROTOCOL_VERSION,
                      ready: false,
                      status: "error",
                  }
                : {
                      healthy: true,
                      identity: options.identity,
                      protocolVersion: RIG_PROTOCOL_VERSION,
                      ready: false,
                      status: "starting",
                  };
        sendJson<HealthResponse>(response, 200, health);
        return;
    }

    if (request.method === "POST" && url.pathname === "/shutdown") {
        sendJson<ShutdownServerResponse>(response, 202, {
            pid: process.pid,
            shuttingDown: true,
        });
        setImmediate(options.onShutdown);
        return;
    }

    sendJson(response, 503, {
        error:
            options.getState().status === "error"
                ? "The local daemon could not start. Check its health status for details."
                : "The local daemon is still starting.",
    });
}

function startupRouteName(pathname: string): string {
    if (pathname === "/health") return "health";
    if (pathname === "/shutdown") return "shutdown";
    return "startup";
}
