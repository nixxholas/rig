import type { HappyMcpCallCompletion, HappyMcpToolResult } from "./types.js";

/** Applies the one public error-result contract shared by the fake host and real Rig. */
export function happyMcpCompletionToResult(completion: HappyMcpCallCompletion): HappyMcpToolResult {
    return "error" in completion
        ? {
              content: [{ text: completion.error, type: "text" }],
              isError: true,
          }
        : completion.result;
}
