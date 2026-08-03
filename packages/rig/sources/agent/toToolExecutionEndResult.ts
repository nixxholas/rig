import type { ToolResultBlock } from "./types.js";

export function toToolExecutionEndResult(
    result: ToolResultBlock,
): Pick<
    ToolResultBlock,
    | "display"
    | "failure"
    | "isError"
    | "presentation"
    | "shared"
    | "toolCallId"
    | "toolName"
    | "type"
> {
    return {
        type: "tool_result",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        display: result.display,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.presentation === undefined ? {} : { presentation: result.presentation }),
        ...(result.shared === undefined ? {} : { shared: result.shared }),
    };
}
