import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

import type { SessionTool } from "@/core/SessionTool.js";

type ResponseTool = NonNullable<ResponseCreateParamsStreaming["tools"]>[number];

export function toResponsesToolDefinitions(tools: readonly SessionTool[]): ResponseTool[] {
    return tools.map((tool) => {
        if (tool.server !== undefined) {
            return structuredClone(tool.server) as ResponseTool;
        }
        return {
            type: "function",
            name: tool.name,
            strict: false,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters:
                tool.parameters === undefined
                    ? {}
                    : (JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>),
        };
    });
}
