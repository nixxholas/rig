import type { SessionTool } from "@/core/SessionTool.js";
import { toJsonSchema } from "@/vendors/codex/impl/toJsonSchema.js";

export function toGrokToolDefinitions(tools: readonly SessionTool[]): readonly unknown[] {
    return tools.map((tool) =>
        tool.server !== undefined
            ? structuredClone(tool.server)
            : {
                  type: "function",
                  name: tool.name,
                  ...(tool.parameters === undefined
                      ? {}
                      : { parameters: toJsonSchema(tool.parameters) }),
                  ...(tool.description === undefined
                      ? {}
                      : { description: tool.description }),
              },
    );
}
