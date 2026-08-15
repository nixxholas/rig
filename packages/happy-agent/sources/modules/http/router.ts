import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@steve.kite/stdlib";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import { AgentHttpError } from "./errors.js";

export type AgentHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface AgentHttpInspector {
    readonly start: () => Promise<string> | string;
    readonly stop: () => Promise<boolean> | boolean;
}

export interface AgentHttpConfiguration {
    readonly p2pName?: string;
    readonly inferenceMaxRetries?: number;
    readonly durableGlobalEventQueue?: boolean;
    readonly instructionsPath?: string;
    readonly securityPath?: string;
    readonly inspector?: AgentHttpInspector;
}

export interface AgentHttpRouteDependencies {
    readonly agent: LoadedHappyAgent;
    readonly configuration?: AgentHttpConfiguration;
    readonly onShutdown?: () => void;
    readonly version?: string;
}

export interface AgentHttpRouteContext {
    readonly ctx: Context;
    readonly dependencies: AgentHttpRouteDependencies;
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly url: URL;
}

export interface AgentHttpRoute {
    readonly method: AgentHttpMethod;
    readonly path: string;
    readonly handle: (context: AgentHttpRouteContext) => Promise<void>;
}

export interface AgentHttpRouteGroup {
    readonly name: string;
    readonly routes: readonly AgentHttpRoute[];
}

export function createRouteGroup(
    name: string,
    routes: readonly AgentHttpRoute[],
): AgentHttpRouteGroup {
    return { name, routes };
}

export async function dispatchAgentHttpRoute(
    context: AgentHttpRouteContext,
    groups: readonly AgentHttpRouteGroup[],
): Promise<void> {
    const matching = groups
        .flatMap((group) => group.routes)
        .filter((route) => route.path === context.url.pathname);
    if (matching.length === 0) {
        throw new AgentHttpError(404, "Route not found.");
    }
    const route = matching.find((candidate) => candidate.method === context.request.method);
    if (route === undefined) {
        const allow = [...new Set(matching.map((candidate) => candidate.method))].join(", ");
        throw new AgentHttpError(405, "Method not allowed.", undefined, { allow });
    }
    await route.handle(context);
}

export function routeContext(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    dependencies: AgentHttpRouteDependencies,
): AgentHttpRouteContext {
    return {
        ctx,
        dependencies,
        request,
        response,
        url: new URL(request.url ?? "/", "http://happy-agent.local"),
    };
}

export { AgentHttpError };
