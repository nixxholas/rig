import type { ContentBlock } from "../agent/types.js";
import type { DurableSkillDefinition } from "../external-skills/types.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ExternalToolDefinition {
    description: string;
    label?: string;
    name: string;
    parameters: JsonSchema;
}

export interface ExternalToolCall {
    arguments: unknown;
    batchId: string;
    createdAt: number;
    definition: ExternalToolDefinition;
    id: string;
    runId: string;
    sessionId: string;
    skill?: DurableSkillDefinition;
    status: "pending" | "completed" | "failed" | "cancelled";
    /** Original identifier emitted by the provider and replayed on the provider wire. */
    providerToolCallId?: string;
    toolCallId: string;
    toolCallIndex: number;
    consumed: boolean;
    resolution?: ExternalToolCallResolution;
    resolvedAt?: number;
}

export type ExternalToolCallResolution =
    | {
          status: "completed";
          content?: readonly ContentBlock[];
          output?: unknown;
      }
    | {
          status: "failed";
          error: {
              code?: string;
              data?: unknown;
              message: string;
          };
      };

export interface ResolveExternalToolCallResponse {
    accepted: boolean;
    call: ExternalToolCall;
}
