import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const catalogModelSchema = Type.Object(
    {
        defaultEffort: Type.String(),
        effortLevels: Type.Array(Type.String()),
        id: Type.String(),
        name: Type.String(),
        providerId: Type.String(),
        serviceTiers: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
);

export function createCoreDaemonRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("core-daemon", [
        {
            method: "GET",
            path: "/v0/health",
            handle: async ({ dependencies, response }) => {
                const catalog = createModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, {
                    catalog,
                    durableGlobalEventQueue: false,
                    healthy: true,
                    identity: daemonIdentity(dependencies),
                    protocolVersion: 0,
                    ready: true,
                    status: "ready",
                });
            },
        },
        {
            method: "GET",
            path: "/v0/installation",
            handle: async ({ dependencies, response }) => {
                sendJson(response, 200, {
                    data: {
                        epoch: dependencies.agent.installation.epoch,
                        schemaCompatibility: "current",
                        schemaVersion: dependencies.agent.installation.schemaVersion,
                        status: "initialized",
                    },
                    daemonProtocolVersion: 0,
                    daemonVersion: daemonIdentity(dependencies).version,
                    formatVersion: 1,
                    source: "daemon",
                });
            },
        },
        {
            method: "GET",
            path: "/v0/models",
            handle: async ({ dependencies, response }) => {
                sendJson(response, 200, {
                    catalog: createModelCatalog(dependencies.agent.system.models),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/shutdown",
            handle: async ({ dependencies, response }) => {
                if (dependencies.onShutdown === undefined) {
                    throw new AgentHttpError(403, "Daemon shutdown is not enabled.");
                }
                sendJson(response, 202, { pid: process.pid, shuttingDown: true });
                setImmediate(dependencies.onShutdown);
            },
        },
    ]);
}

export interface HappyModelCatalog {
    readonly defaultModelId: string;
    readonly defaultProviderId: string;
    readonly models: readonly unknown[];
    readonly providers: readonly {
        readonly models: readonly unknown[];
        readonly providerId: string;
    }[];
}

function createModelCatalog(models: readonly unknown[]): HappyModelCatalog {
    const typedModels = models.filter(isModel);
    const providerIds = [...new Set(typedModels.map((model) => model.providerId))];
    const first = typedModels[0];
    return {
        defaultModelId: first?.id ?? "",
        defaultProviderId: first?.providerId ?? "",
        models: typedModels,
        providers: providerIds.map((providerId) => ({
            models: typedModels.filter((model) => model.providerId === providerId),
            providerId,
        })),
    };
}

function isModel(value: unknown): value is {
    readonly defaultEffort: string;
    readonly effortLevels: readonly string[];
    readonly id: string;
    readonly name: string;
    readonly providerId: string;
    readonly serviceTiers?: readonly string[];
} {
    return Value.Check(catalogModelSchema, value);
}

function daemonIdentity(dependencies: { readonly version?: string }): { readonly version: string } {
    return { version: dependencies.version ?? "0.0.0" };
}
