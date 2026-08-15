import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";
import {
    ProjectFileError,
    ProjectFilesModule,
    fileReadQuerySchema,
    fileRevisionQuerySchema,
    fileSearchQuerySchema,
    fileTreeQuerySchema,
    fileWriteSchema,
    type FileReadQuery,
    type FileRevisionQuery,
    type FileSearchQuery,
    type FileTreeQuery,
} from "../files/ProjectFilesModule.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import {
    createRouteGroup,
    type AgentHttpRouteContext,
    type AgentHttpRoute,
    type AgentHttpRouteGroup,
} from "./router.js";
import { Value } from "@sinclair/typebox/value";

export interface FileRouteOptions {
    readonly agent: LoadedHappyAgent;
    readonly files: ProjectFilesModule;
}

export function createFileRoutes(options: FileRouteOptions): AgentHttpRouteGroup {
    const agentId = options.agent.agent.id;
    const routes: AgentHttpRoute[] = [
        createSearchRoute("/v0/projects/:projectId/files"),
        createSearchRoute("/v0/projects/:projectId/workspaces/:workspaceId/files"),
        createPathsRoute("/v0/projects/:projectId/file-paths"),
        createPathsRoute("/v0/projects/:projectId/workspaces/:workspaceId/file-paths"),
        createTreeRoute("/v0/projects/:projectId/file-tree"),
        createTreeRoute("/v0/projects/:projectId/workspaces/:workspaceId/file-tree"),
        createReadRoute("/v0/projects/:projectId/file"),
        createReadRoute("/v0/projects/:projectId/workspaces/:workspaceId/file"),
        createRevisionRoute("/v0/projects/:projectId/file-revision"),
        createRevisionRoute("/v0/projects/:projectId/workspaces/:workspaceId/file-revision"),
        {
            method: "PUT" as const,
            path: "/v0/projects/:projectId/file",
            handle: async ({ ctx, request, response, url }) => {
                await writeFile(
                    ctx,
                    request,
                    response,
                    url.pathname,
                    "/v0/projects/:projectId/file",
                );
            },
        },
        {
            method: "PUT" as const,
            path: "/v0/projects/:projectId/workspaces/:workspaceId/file",
            handle: async ({ ctx, request, response, url }) => {
                await writeFile(
                    ctx,
                    request,
                    response,
                    url.pathname,
                    "/v0/projects/:projectId/workspaces/:workspaceId/file",
                );
            },
        },
    ];
    return createRouteGroup("files", routes);

    function createSearchRoute(path: string) {
        return {
            method: "GET" as const,
            path,
            handle: async ({ ctx, response, url }: AgentHttpRouteContext) => {
                const params = requireParams(url.pathname, path);
                const root = await resolveRoot(ctx, params);
                const query = parseSearchQuery(url);
                sendJson(
                    response,
                    200,
                    await fileOperation(() => options.files.search(root, query)),
                );
            },
        };
    }

    function createPathsRoute(path: string) {
        return {
            method: "GET" as const,
            path,
            handle: async ({ ctx, response, url }: AgentHttpRouteContext) => {
                const params = requireParams(url.pathname, path);
                const root = await resolveRoot(ctx, params);
                sendJson(response, 200, await fileOperation(() => options.files.listPaths(root)));
            },
        };
    }

    function createTreeRoute(path: string) {
        return {
            method: "GET" as const,
            path,
            handle: async ({ ctx, response, url }: AgentHttpRouteContext) => {
                const params = requireParams(url.pathname, path);
                const root = await resolveRoot(ctx, params);
                sendJson(
                    response,
                    200,
                    await fileOperation(() => options.files.tree(root, parseTreeQuery(url))),
                );
            },
        };
    }

    function createReadRoute(path: string) {
        return {
            method: "GET" as const,
            path,
            handle: async ({ ctx, response, url }: AgentHttpRouteContext) => {
                const params = requireParams(url.pathname, path);
                const root = await resolveRoot(ctx, params);
                sendJson(
                    response,
                    200,
                    await fileOperation(() => options.files.read(root, parseReadQuery(url))),
                );
            },
        };
    }

    function createRevisionRoute(path: string) {
        return {
            method: "GET" as const,
            path,
            handle: async ({ ctx, response, url }: AgentHttpRouteContext) => {
                const params = requireParams(url.pathname, path);
                const root = await resolveRoot(ctx, params);
                sendJson(
                    response,
                    200,
                    await fileOperation(() =>
                        options.files.readRevision(root, parseRevisionQuery(url)),
                    ),
                );
            },
        };
    }

    async function writeFile(
        ctx: import("@steve.kite/stdlib").Context,
        request: import("node:http").IncomingMessage,
        response: import("node:http").ServerResponse,
        pathname: string,
        template: string,
    ): Promise<void> {
        const params = requireParams(pathname, template);
        const root = await resolveRoot(ctx, params);
        const result = await fileOperation(async () =>
            options.files.write(root, await readValidatedBody(request, fileWriteSchema)),
        );
        sendJson(response, 200, result);
    }

    async function resolveRoot(
        ctx: import("@steve.kite/stdlib").Context,
        params: Record<string, string>,
    ) {
        return await fileOperation(() =>
            options.files.resolveRoot(
                ctx,
                agentId,
                requireParam(params, "projectId"),
                params.workspaceId,
            ),
        );
    }
}

function queryObject(url: URL): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
        if (output[key] !== undefined)
            throw new AgentHttpError(400, `The query parameter '${key}' is duplicated.`);
        output[key] = value;
    }
    return output;
}

function parseSearchQuery(url: URL): FileSearchQuery {
    const value = queryObject(url);
    const query = {
        ...(value.query === undefined ? {} : { query: value.query }),
        ...(value.limit === undefined ? {} : { limit: parseInteger(value.limit, "limit") }),
    };
    if (!Value.Check(fileSearchQuerySchema, query)) {
        throw new AgentHttpError(400, "The file search query is invalid.");
    }
    return query as FileSearchQuery;
}

function parseTreeQuery(url: URL): FileTreeQuery {
    const value = queryObject(url);
    const query = {
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
        ...(value.limit === undefined ? {} : { limit: parseInteger(value.limit, "limit") }),
    };
    if (!Value.Check(fileTreeQuerySchema, query)) {
        throw new AgentHttpError(400, "The file-tree query is invalid.");
    }
    return query as FileTreeQuery;
}

function parseReadQuery(url: URL): FileReadQuery {
    const query = queryObject(url);
    if (!Value.Check(fileReadQuerySchema, query)) {
        throw new AgentHttpError(400, "The file read query is invalid.");
    }
    return query as FileReadQuery;
}

function parseRevisionQuery(url: URL): FileRevisionQuery {
    const query = queryObject(url);
    if (!Value.Check(fileRevisionQuerySchema, query)) {
        throw new AgentHttpError(400, "The file revision query is invalid.");
    }
    return query as FileRevisionQuery;
}

function parseInteger(value: string, name: string): number {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new AgentHttpError(400, `The ${name} must be an integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new AgentHttpError(400, `The ${name} is invalid.`);
    return parsed;
}

function requireParams(pathname: string, template: string): Record<string, string> {
    const actual = pathname.split("/").filter(Boolean);
    const expected = template.split("/").filter(Boolean);
    if (actual.length !== expected.length) throw new AgentHttpError(404, "Route not found.");
    const params: Record<string, string> = {};
    expected.forEach((value, index) => {
        if (value.startsWith(":")) params[value.slice(1)] = decodeURIComponent(actual[index] ?? "");
        else if (value !== actual[index]) throw new AgentHttpError(404, "Route not found.");
    });
    return params;
}

function requireParam(params: Record<string, string>, name: string): string {
    const value = params[name];
    if (value === undefined || value.length === 0)
        throw new AgentHttpError(404, "Route not found.");
    return value;
}

async function fileOperation<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof ProjectFileError) {
            throw new AgentHttpError(error.status, error.message, { code: error.code });
        }
        throw error;
    }
}
