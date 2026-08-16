import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

import type { SessionTool } from "@/core/SessionTool.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

type ResponseTool = NonNullable<ResponseCreateParamsStreaming["tools"]>[number];

export function toResponsesToolDefinitions(tools: readonly SessionTool[]): ResponseTool[] {
    return tools.map((tool) => {
        if (tool.server !== undefined) {
            const server = structuredClone(tool.server) as ResponseTool & { parameters?: unknown };
            if (server.parameters && typeof server.parameters === "object") {
                server.parameters = toLlmParametersSchema(server.parameters as any);
            }
            return server;
        }
        const parameters = toLlmParametersSchema(tool.parameters);
        return {
            type: "function",
            name: tool.name,
            strict: false,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters,
        };
    });
}
