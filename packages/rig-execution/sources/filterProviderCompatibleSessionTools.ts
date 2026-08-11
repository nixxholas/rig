import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SessionTool } from "@slopus/happy-providers";

const providerToolParametersSchema = Type.Union([
    Type.Undefined(),
    Type.Object(
        {
            type: Type.Literal("object"),
        },
        { additionalProperties: true },
    ),
]);

export function filterProviderCompatibleSessionTools(tools: readonly SessionTool[]): SessionTool[] {
    return tools.filter((tool) => Value.Check(providerToolParametersSchema, tool.parameters));
}
