import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

export function createInspectorRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("inspector", [
        {
            method: "POST",
            path: "/v0/debug/inspector",
            handle: async ({ dependencies, response }) => {
                const inspector = dependencies.configuration?.inspector;
                if (inspector === undefined) {
                    throw new AgentHttpError(409, "This daemon cannot start a debugger.");
                }
                sendJson(response, 200, { inspectorUrl: await inspector.start() });
            },
        },
        {
            method: "DELETE",
            path: "/v0/debug/inspector",
            handle: async ({ dependencies, response }) => {
                const inspector = dependencies.configuration?.inspector;
                if (inspector === undefined) {
                    throw new AgentHttpError(409, "This daemon cannot stop a debugger.");
                }
                sendJson(response, 200, { stopped: await inspector.stop() });
            },
        },
    ]);
}
