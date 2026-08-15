import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@steve.kite/stdlib";

import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import type { ProjectFilesModule } from "../files/ProjectFilesModule.js";
import type { GitModule } from "../git/GitModule.js";
import type { ProjectWorkspaceHost } from "../projects/ProjectHost.js";
import { AgentHttpError } from "./errors.js";

export type AgentHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface AgentHttpInspector {
    readonly start: () => Promise<string> | string;
    readonly stop: () => Promise<boolean> | boolean;
}

export interface AgentHttpConfiguration {
    readonly git?: GitModule;
    readonly p2pName?: string;
    readonly projectFiles?: ProjectFilesModule;
    readonly projectHost?: ProjectWorkspaceHost;
    readonly inferenceMaxRetries?: number;
    readonly durableGlobalEventQueue?: boolean;
    readonly instructionsPath?: string;
    /** Receives unexpected request failures without exposing their details to HTTP clients. */
    readonly onUnexpectedError?: (error: unknown) => void;
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
    readonly params: Readonly<Record<string, string>>;
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
        .flatMap((route) => {
            const match = matchRoute(route.path, context.url.pathname);
            return match === undefined ? [] : [{ match, route }];
        })
        .sort((left, right) => right.match.specificity - left.match.specificity);
    if (matching.length === 0) {
        throw new AgentHttpError(404, "Route not found.");
    }
    const selected = matching.find(
        (candidate) => candidate.route.method === context.request.method,
    );
    if (selected === undefined) {
        const allow = [...new Set(matching.map((candidate) => candidate.route.method))].join(", ");
        throw new AgentHttpError(405, "Method not allowed.", undefined, { allow });
    }
    await selected.route.handle({ ...context, params: selected.match.params });
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
        params: {},
        request,
        response,
        url: new URL(request.url ?? "/", "http://happy-agent.local"),
    };
}

export { AgentHttpError };

interface RouteMatch {
    readonly params: Readonly<Record<string, string>>;
    readonly specificity: number;
}

function matchRoute(pattern: string, pathname: string): RouteMatch | undefined {
    const expected = splitPath(pattern);
    const actual = splitPath(pathname);
    if (expected.length !== actual.length) return undefined;

    const params: Record<string, string> = {};
    let specificity = 0;
    for (let index = 0; index < expected.length; index += 1) {
        const expectedSegment = expected[index];
        const actualSegment = actual[index];
        if (expectedSegment === undefined || actualSegment === undefined) return undefined;
        if (expectedSegment.startsWith(":")) {
            try {
                params[expectedSegment.slice(1)] = decodeURIComponent(actualSegment);
            } catch {
                throw new AgentHttpError(400, "The request path is not valid.");
            }
            continue;
        }
        if (expectedSegment !== actualSegment) return undefined;
        specificity += 1;
    }
    return { params, specificity };
}

function splitPath(path: string): readonly string[] {
    if (path === "/") return [];
    return (path.startsWith("/") ? path.slice(1) : path).split("/");
}
