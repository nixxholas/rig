import { Value } from "@sinclair/typebox/value";

import type { AgentContext } from "./context/AgentContext.js";
import type { SharedToolActivity } from "./SharedToolActivity.js";
import type { ToolCallPresentation } from "./ToolCallPresentation.js";
import { toSharedToolActivity } from "./toSharedToolActivity.js";
import type { AnyDefinedTool } from "./types.js";
import type { ToolCall as ProviderToolCall } from "@slopus/rig-execution";

export type PresentedToolCall = ProviderToolCall & {
    presentation?: ToolCallPresentation;
    shared?: SharedToolActivity;
};

export function presentToolCall(
    toolCall: ProviderToolCall,
    tools: readonly AnyDefinedTool[],
    context: AgentContext,
): PresentedToolCall {
    const tool = tools.find((candidate) => candidate.name === toolCall.name);
    if (tool === undefined || !Value.Check(tool.arguments, toolCall.arguments)) {
        return toolCall;
    }

    const toSharedCall = tool.toSharedCall as ((args: unknown) => string | undefined) | undefined;
    const shared = toSharedToolActivity(tool, () => toSharedCall?.(toolCall.arguments));
    const presentation = callPresentation(tool, toolCall, context);
    return presentation === undefined && shared === undefined
        ? toolCall
        : {
              ...toolCall,
              ...(presentation === undefined ? {} : { presentation }),
              ...(shared === undefined ? {} : { shared }),
          };
}

function callPresentation(
    tool: AnyDefinedTool,
    toolCall: ProviderToolCall,
    context: AgentContext,
): ToolCallPresentation | undefined {
    if (tool.toCallPresentation === undefined) return undefined;
    try {
        return tool.toCallPresentation(toolCall.arguments as never, context);
    } catch {
        return undefined;
    }
}
