import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { SessionToolCall } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { searchCodexTools } from "@/vendors/codex/impl/searchCodexTools.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";

const toolSearchArgumentsSchema = Type.Object(
    {
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
);

export interface CodexToolSearchResult {
    assistantText: string;
    responseItems: readonly string[];
    toolCalls: readonly SessionToolCall[];
}

export function settleCodexToolSearch<T extends CodexToolSearchResult>(
    result: T,
    tools: readonly SessionTool[],
): { result: T; settled: boolean } {
    const searches = result.toolCalls.filter(isClientToolSearchCall);
    if (searches.length === 0) return { result, settled: false };
    const deferredTools = tools.filter(
        (tool) => tool.server === undefined && tool.deferLoading === true,
    );
    const outputs = searches.map((call) => {
        let matched: readonly SessionTool[] = [];
        try {
            const parsed: unknown = JSON.parse(call.arguments);
            if (Value.Check(toolSearchArgumentsSchema, parsed)) {
                matched = searchCodexTools(deferredTools, parsed.query, parsed.limit);
            }
        } catch {
            // Invalid discovery input is settled as an empty result so the model can recover.
        }
        return JSON.stringify({
            type: "tool_search_output",
            call_id: call.callId,
            execution: "client",
            status: "completed",
            tools: toCodexToolDefinitions(matched, { includeDeferred: true }).filter(
                (tool) => tool.type !== "tool_search",
            ),
        });
    });
    return {
        settled: true,
        result: {
            ...result,
            responseItems: [...result.responseItems, ...outputs],
            toolCalls: result.toolCalls.filter((call) => !isClientToolSearchCall(call)),
        } as T,
    };
}

function isClientToolSearchCall(call: SessionToolCall): boolean {
    const vendor =
        typeof call.vendor === "object" && call.vendor !== null
            ? (call.vendor as { provider?: unknown; type?: unknown })
            : undefined;
    return vendor?.provider === "codex" && vendor.type === "tool_search_call";
}
