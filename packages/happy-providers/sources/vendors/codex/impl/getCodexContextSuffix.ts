import type { SessionMessage } from "@/core/SessionContext.js";
import { codexValuesEqual } from "@/vendors/codex/impl/codexValuesEqual.js";

export function getCodexContextSuffix(
    previous: readonly SessionMessage[],
    current: readonly SessionMessage[],
): SessionMessage[] | undefined {
    if (
        previous.length > current.length ||
        !previous.every((message, index) =>
            codexValuesEqual(toCallerIdentity(message), toCallerIdentity(current[index])),
        )
    ) {
        return undefined;
    }
    return structuredClone(current.slice(previous.length));
}

function toCallerIdentity(message: SessionMessage | undefined): unknown {
    if (message?.role !== "assistant") return message;
    const clone = structuredClone(message);
    delete (clone as { encryptedReasoning?: string }).encryptedReasoning;
    delete (clone as { reasoning?: unknown }).reasoning;
    delete (clone as { responseItems?: readonly string[] }).responseItems;
    if (clone.toolCalls !== undefined) {
        return {
            ...clone,
            toolCalls: clone.toolCalls.map((call) => ({
                ...call,
                arguments: isCustomToolCall(call.vendor)
                    ? call.arguments
                    : parseArguments(call.arguments),
            })),
        };
    }
    return clone;
}

function parseArguments(argumentsJson: string): unknown {
    try {
        return JSON.parse(argumentsJson);
    } catch {
        return argumentsJson;
    }
}

function isCustomToolCall(vendor: unknown): boolean {
    return (
        typeof vendor === "object" &&
        vendor !== null &&
        "provider" in vendor &&
        vendor.provider === "codex" &&
        "type" in vendor &&
        vendor.type === "custom_tool_call"
    );
}
