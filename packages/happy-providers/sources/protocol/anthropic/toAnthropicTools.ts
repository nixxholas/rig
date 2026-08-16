import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { SessionTool } from "@/core/SessionTool.js";
import { toAnthropicToolName } from "@/protocol/anthropic/toAnthropicToolName.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

export function toAnthropicTools(tools: readonly SessionTool[]): BetaTool[] {
    return tools.map((tool) => {
        if (tool.server !== undefined) {
            throw new Error(
                `Anthropic Bedrock does not support server tool '${tool.name}' through this transport.`,
            );
        }
        const schema = toLlmParametersSchema(tool.parameters) as Record<string, unknown> & {
            type: "object";
        };
        return {
            name: toAnthropicToolName(tool),
            description: tool.description ?? "",
            input_schema: { ...schema, type: "object" as const },
        };
    });
}
