import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import {
    createRigModelCatalog,
    HAPPY_AGENT_RIG_PROTOCOL_VERSION,
    type RigModelCatalog,
} from "./rigProtocol.js";

export function createCoreDaemonRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("core-daemon", [
        {
            method: "GET",
            path: "/v0/health",
            handle: async ({ dependencies, response }) => {
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, {
                    catalog,
                    durableGlobalEventQueue:
                        dependencies.configuration?.durableGlobalEventQueue ?? false,
                    healthy: true,
                    identity: daemonIdentity(dependencies),
                    protocolVersion: HAPPY_AGENT_RIG_PROTOCOL_VERSION,
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
                    daemonProtocolVersion: HAPPY_AGENT_RIG_PROTOCOL_VERSION,
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
                    catalog: createRigModelCatalog(dependencies.agent.system.models),
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

export type HappyModelCatalog = RigModelCatalog;

function daemonIdentity(dependencies: {
    readonly configuration?: { readonly identity?: { readonly version: string } };
    readonly version?: string;
}): { readonly version: string } {
    return dependencies.configuration?.identity ?? { version: dependencies.version ?? "0.0.0" };
}
