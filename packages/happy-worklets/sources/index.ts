export { createWorkletClient, WorkletApiError } from "./createWorkletClient.js";
export { defineWorkletTool } from "./startWorkletTools.js";
export { Type } from "@sinclair/typebox";
export type { Static, TSchema } from "@sinclair/typebox";
export {
    emptyWorkletResponseSchema,
    registerWorkletToolsRequestSchema,
    registerWorkletToolsResponseSchema,
    workletCallCompletionSchema,
    workletEventSchema,
    workletReadyRequestSchema,
    workletStatusRequestSchema,
    workletToolRegistrationSchema,
    workletToolResultSchema,
} from "./types.js";
export type {
    RegisterWorkletToolsRequest,
    WorkletCallCompletion,
    WorkletEvent,
    CreateWorkletClientOptions,
    WorkletClient,
    WorkletContent,
    WorkletToolContext,
    WorkletToolDefinition,
    WorkletToolResult,
} from "./types.js";

import { createWorkletClient } from "./createWorkletClient.js";
import type { WorkletClient } from "./types.js";

/**
 * The worklet's whole view of Rig.
 *
 * It reads the socket path, the token, the worklet's name, and its data folder from the
 * environment Rig started it with, so a worklet never finds credentials or paths for itself.
 */
export const worklet: WorkletClient = createLazyWorkletClient();

function createLazyWorkletClient(): WorkletClient {
    let client: WorkletClient | undefined;
    const resolve = () => (client ??= createWorkletClient());
    return {
        get data() {
            return resolve().data;
        },
        get name() {
            return resolve().name;
        },
        ready: (status) => resolve().ready(status),
        status: (status) => resolve().status(status),
        tools: (tools) => resolve().tools(tools),
    };
}
