import type { ExternalToolCall, ExternalToolDefinition } from "../../../external-tools/index.js";
import { readNumber, readOptionalNumber, readOptionalString, readString } from "./sqliteRow.js";

export function readExternalToolCallRow(row: Record<string, unknown>): ExternalToolCall {
    const providerToolCallId = readOptionalString(row, "provider_tool_call_id");
    const resolutionJson = readOptionalString(row, "resolution_json");
    const skillJson = readOptionalString(row, "skill_json");
    const resolvedAt = readOptionalNumber(row, "resolved_at_ms");
    return {
        arguments: JSON.parse(readString(row, "arguments_json")),
        batchId: readString(row, "batch_id"),
        consumed: readNumber(row, "consumed") !== 0,
        createdAt: readNumber(row, "created_at_ms"),
        definition: JSON.parse(readString(row, "definition_json")) as ExternalToolDefinition,
        ...(providerToolCallId === undefined ? {} : { providerToolCallId }),
        ...(resolutionJson === undefined ? {} : { resolution: JSON.parse(resolutionJson) }),
        ...(resolvedAt === undefined ? {} : { resolvedAt }),
        id: readString(row, "id"),
        runId: readString(row, "run_id"),
        sessionId: readString(row, "session_id"),
        ...(skillJson === undefined ? {} : { skill: JSON.parse(skillJson) }),
        status: readString(row, "status") as ExternalToolCall["status"],
        toolCallId: readString(row, "tool_call_id"),
        toolCallIndex: readNumber(row, "tool_call_index"),
    };
}
