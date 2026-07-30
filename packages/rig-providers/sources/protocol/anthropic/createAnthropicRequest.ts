import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { toAnthropicSystem } from "@/protocol/anthropic/toAnthropicSystem.js";
import { toAnthropicTools } from "@/protocol/anthropic/toAnthropicTools.js";

export type AnthropicRequest = MessageCreateParamsStreaming;

export function createAnthropicRequest(options: {
    compaction?: {
        instructions?: string;
    };
    context: SessionContext;
    effort?: SessionReasoningEffort;
    model: string;
    tools: readonly SessionTool[];
}): AnthropicRequest {
    const effort = resolveEffort(options.effort);
    const system = toAnthropicSystem(options);
    const tools = toAnthropicTools(options.tools);
    const hasCompaction = options.context.messages.some((message) => message.role === "compaction");
    const usesCompaction = options.compaction !== undefined || hasCompaction;
    const betas = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"];
    if (usesCompaction) betas.push("compact-2026-01-12");
    return {
        betas,
        ...(!usesCompaction
            ? {}
            : {
                  context_management: {
                      edits: [
                          {
                              type: "compact_20260112" as const,
                              ...(options.compaction?.instructions === undefined
                                  ? {}
                                  : { instructions: options.compaction.instructions }),
                              pause_after_compaction: true,
                              trigger: { type: "input_tokens" as const, value: 50_000 },
                          },
                      ],
                  },
              }),
        max_tokens: 64_000,
        messages: toAnthropicMessages(options.context.messages),
        model: options.model,
        stream: true,
        ...(system.length === 0 ? {} : { system }),
        thinking: options.effort === "off" ? { type: "disabled" } : { type: "adaptive" },
        ...(options.effort === "off" ? {} : { output_config: { effort } }),
        ...(tools.length === 0 ? {} : { tools }),
    };
}

function resolveEffort(
    effort: SessionReasoningEffort | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" {
    if (effort === undefined) return "high";
    if (effort === "off" || effort === "minimal") return "low";
    return effort;
}
