import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";

import { EMPTY_SESSION_CACHE_USAGE, type SessionCacheUsage } from "@/core/SessionCacheUsage.js";
import type { SessionToolCall } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { toSessionCacheUsage } from "@/protocol/responses/toSessionCacheUsage.js";
import type {
    ResponsesToolCallType,
    ResponsesToolVendor,
} from "@/protocol/responses/ResponsesToolVendor.js";
import { responseStreamError } from "@/protocol/responses/responseStreamError.js";

interface ActiveOutputItem {
    callId?: string;
    name?: string;
    namespace?: string;
    type:
        | "message"
        | "reasoning"
        | "function_call"
        | "custom_tool_call"
        | "tool_search_call"
        | "server_tool_call";
    argumentsJson?: string;
    receivedTextDelta?: boolean;
}

export interface OpenAIResponseRunResult {
    assistantText: string;
    encryptedReasoning?: string | undefined;
    responseItems: readonly string[];
    stopReason: "stop" | "length" | "tool_use";
    toolCalls: readonly SessionToolCall[];
    usage: SessionCacheUsage;
}

/**
 * Maps the OpenAI Responses event protocol shared by Codex, Grok, and Bedrock Mantle.
 *
 * The vendor only selects how tool-call metadata is stamped; the event grammar is identical.
 * It defaults to Grok, so Codex callers must pass it explicitly.
 */
export async function* mapOpenAIResponseStream(
    responseStream: AsyncIterable<ResponseStreamEvent>,
    options: {
        signal?: AbortSignal;
        failureMessage: string;
        requireTerminalEvent?: boolean;
        vendor?: "codex" | "grok" | "responses";
        /**
         * Names of the tools this request declared for the client to execute. A custom tool call
         * for anything else came from a hosted tool the provider ran itself, so it is reported as
         * a server tool call instead of one the client is expected to answer.
         */
        clientToolNames?: ReadonlySet<string>;
    },
): AsyncGenerator<SessionEvent, OpenAIResponseRunResult> {
    const activeItems = new Map<number, ActiveOutputItem>();
    let assistantText = "";
    let encryptedReasoning: string | undefined;
    let sawToolUse = false;
    const toolCalls: SessionToolCall[] = [];
    const responseItems = new Map<number, string>();
    let usage: SessionCacheUsage = { ...EMPTY_SESSION_CACHE_USAGE };

    for await (const event of responseStream) {
        if (options.signal?.aborted) {
            return {
                assistantText,
                encryptedReasoning,
                responseItems: [...responseItems.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, item]) => item),
                stopReason: "stop",
                toolCalls,
                usage,
            };
        }

        if (event.type === "response.output_item.added") {
            if (event.item.type === "reasoning") {
                activeItems.set(event.output_index, { type: "reasoning" });
            } else if (event.item.type === "message") {
                activeItems.set(event.output_index, { type: "message" });
            } else if (event.item.type === "function_call") {
                sawToolUse = true;
                activeItems.set(event.output_index, {
                    type: "function_call",
                    callId: event.item.call_id,
                    name: event.item.name,
                    ...(event.item.namespace === undefined
                        ? {}
                        : { namespace: event.item.namespace }),
                    argumentsJson: event.item.arguments,
                });
                yield {
                    type: "tool_call_start",
                    callId: event.item.call_id,
                    name: event.item.name,
                    ...(event.item.namespace === undefined
                        ? {}
                        : { namespace: event.item.namespace }),
                    vendor: responseToolVendor(options.vendor, "function_call"),
                };
                if (event.item.arguments.length > 0) {
                    yield {
                        type: "tool_call_delta",
                        callId: event.item.call_id,
                        delta: event.item.arguments,
                    };
                }
            } else if (
                event.item.type === "custom_tool_call" &&
                serverExecutedItemName(event.item, options.clientToolNames) !== undefined
            ) {
                activeItems.set(event.output_index, {
                    type: "server_tool_call",
                    callId: event.item.call_id,
                    name: event.item.name,
                    argumentsJson: event.item.input,
                });
                yield {
                    type: "server_tool_call_start",
                    callId: event.item.call_id,
                    name: event.item.name,
                };
                if (event.item.input.length > 0) {
                    yield {
                        type: "server_tool_call_delta",
                        callId: event.item.call_id,
                        delta: event.item.input,
                    };
                }
            } else if (event.item.type === "custom_tool_call") {
                sawToolUse = true;
                activeItems.set(event.output_index, {
                    type: "custom_tool_call",
                    callId: event.item.call_id,
                    name: event.item.name,
                    ...(event.item.namespace === undefined
                        ? {}
                        : { namespace: event.item.namespace }),
                    argumentsJson: event.item.input,
                });
                yield {
                    type: "tool_call_start",
                    callId: event.item.call_id,
                    name: event.item.name,
                    ...(event.item.namespace === undefined
                        ? {}
                        : { namespace: event.item.namespace }),
                    vendor: responseToolVendor(options.vendor, "custom_tool_call"),
                };
                if (event.item.input.length > 0) {
                    yield {
                        type: "tool_call_delta",
                        callId: event.item.call_id,
                        delta: event.item.input,
                    };
                }
            } else if (
                event.item.type === "tool_search_call" &&
                event.item.execution === "client" &&
                event.item.call_id !== null
            ) {
                sawToolUse = true;
                const argumentsJson = JSON.stringify(event.item.arguments);
                activeItems.set(event.output_index, {
                    type: "tool_search_call",
                    callId: event.item.call_id,
                    name: "tool_search",
                    argumentsJson,
                });
                yield {
                    type: "tool_call_start",
                    callId: event.item.call_id,
                    name: "tool_search",
                    vendor: responseToolVendor(options.vendor, "tool_search_call"),
                };
                yield {
                    type: "tool_call_delta",
                    callId: event.item.call_id,
                    delta: argumentsJson,
                };
            } else {
                const name = serverExecutedItemName(event.item, options.clientToolNames);
                if (name !== undefined) {
                    const callId = serverToolCallId(event.item, event.output_index);
                    activeItems.set(event.output_index, {
                        type: "server_tool_call",
                        callId,
                        name,
                    });
                    yield { type: "server_tool_call_start", callId, name };
                }
            }
            continue;
        }

        if (
            event.type === "response.reasoning_summary_text.delta" ||
            event.type === "response.reasoning_text.delta"
        ) {
            const activeItem = activeItems.get(event.output_index);
            if (activeItem?.type !== "reasoning") continue;
            yield { type: "reasoning_delta", delta: event.delta };
            continue;
        }

        if (event.type === "response.reasoning_summary_part.done") {
            yield { type: "reasoning_delta", delta: "\n\n" };
            continue;
        }

        if (
            event.type === "response.output_text.delta" ||
            event.type === "response.refusal.delta"
        ) {
            const activeItem = activeItems.get(event.output_index);
            if (activeItem?.type !== "message") continue;
            activeItem.receivedTextDelta = true;
            assistantText += event.delta;
            yield { type: "text_delta", delta: event.delta };
            continue;
        }

        if (event.type === "response.function_call_arguments.delta") {
            const activeItem = activeItems.get(event.output_index);
            if (activeItem?.type !== "function_call" || activeItem.callId === undefined) continue;
            activeItem.argumentsJson = (activeItem.argumentsJson ?? "") + event.delta;
            yield {
                type: "tool_call_delta",
                callId: activeItem.callId,
                delta: event.delta,
            };
            continue;
        }

        if (event.type === "response.custom_tool_call_input.delta") {
            const activeItem = activeItems.get(event.output_index);
            if (activeItem?.callId === undefined) continue;
            if (activeItem.type === "server_tool_call") {
                activeItem.argumentsJson = (activeItem.argumentsJson ?? "") + event.delta;
                yield {
                    type: "server_tool_call_delta",
                    callId: activeItem.callId,
                    delta: event.delta,
                };
                continue;
            }
            if (activeItem.type !== "custom_tool_call") continue;
            activeItem.argumentsJson = (activeItem.argumentsJson ?? "") + event.delta;
            yield {
                type: "tool_call_delta",
                callId: activeItem.callId,
                delta: event.delta,
            };
            continue;
        }

        if (event.type === "response.output_item.done") {
            const activeItem = activeItems.get(event.output_index);
            responseItems.set(event.output_index, JSON.stringify(event.item));
            if (event.item.type === "reasoning") {
                encryptedReasoning = JSON.stringify(event.item);
                yield { type: "encrypted_reasoning", content: encryptedReasoning };
            }
            if (event.item.type === "message") {
                if (activeItem?.receivedTextDelta !== true) {
                    assistantText += event.item.content
                        .map((part) => (part.type === "output_text" ? part.text : part.refusal))
                        .join("");
                }
            }
            const serverToolName =
                activeItem?.type === "server_tool_call"
                    ? activeItem.name
                    : serverExecutedItemName(event.item, options.clientToolNames);
            if (serverToolName !== undefined) {
                const callId =
                    activeItem?.callId ?? serverToolCallId(event.item, event.output_index);
                const argumentsJson = serverToolCallArguments(event.item);
                if (activeItem === undefined) {
                    yield { type: "server_tool_call_start", callId, name: serverToolName };
                }
                yield {
                    type: "server_tool_call_end",
                    callId,
                    name: serverToolName,
                    arguments: argumentsJson,
                };
                activeItems.delete(event.output_index);
                continue;
            }
            if (
                event.item.type === "function_call" &&
                (activeItem === undefined || activeItem.type === "function_call")
            ) {
                if (activeItem === undefined) {
                    sawToolUse = true;
                    yield {
                        type: "tool_call_start",
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        vendor: responseToolVendor(options.vendor, "function_call"),
                    };
                    if (event.item.arguments.length > 0) {
                        yield {
                            type: "tool_call_delta",
                            callId: event.item.call_id,
                            delta: event.item.arguments,
                        };
                    }
                }
                toolCalls.push({
                    callId: event.item.call_id,
                    name: event.item.name,
                    ...(event.item.namespace === undefined
                        ? {}
                        : { namespace: event.item.namespace }),
                    arguments: event.item.arguments,
                    ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                    vendor: responseToolVendor(options.vendor, "function_call"),
                });
                yield {
                    type: "tool_call_end",
                    callId: event.item.call_id,
                    arguments: event.item.arguments,
                    ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                };
            }
            if (
                event.item.type === "custom_tool_call" &&
                (activeItem === undefined || activeItem.type === "custom_tool_call")
            ) {
                if (activeItem === undefined) {
                    sawToolUse = true;
                    yield {
                        type: "tool_call_start",
                        callId: event.item.call_id,
                        name: event.item.name,
                        ...(event.item.namespace === undefined
                            ? {}
                            : { namespace: event.item.namespace }),
                        vendor: responseToolVendor(options.vendor, "custom_tool_call"),
                    };
                    if (event.item.input.length > 0) {
                        yield {
                            type: "tool_call_delta",
                            callId: event.item.call_id,
                            delta: event.item.input,
                        };
                    }
                }
                toolCalls.push({
                    callId: event.item.call_id,
                    name: event.item.name,
                    ...(event.item.namespace === undefined
                        ? {}
                        : { namespace: event.item.namespace }),
                    arguments: event.item.input,
                    ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                    vendor: responseToolVendor(options.vendor, "custom_tool_call"),
                });
                yield {
                    type: "tool_call_end",
                    callId: event.item.call_id,
                    arguments: event.item.input,
                    ...(isIncompleteOutputItem(event.item) ? { incomplete: true } : {}),
                };
            }
            if (
                event.item.type === "tool_search_call" &&
                event.item.execution === "client" &&
                event.item.call_id !== null
            ) {
                const callId = event.item.call_id;
                const argumentsJson = JSON.stringify(event.item.arguments);
                if (activeItem?.type !== "tool_search_call") {
                    sawToolUse = true;
                    yield {
                        type: "tool_call_start",
                        callId,
                        name: "tool_search",
                        vendor: responseToolVendor(options.vendor, "tool_search_call"),
                    };
                    yield {
                        type: "tool_call_delta",
                        callId,
                        delta: argumentsJson,
                    };
                }
                toolCalls.push({
                    callId,
                    name: "tool_search",
                    arguments: argumentsJson,
                    vendor: responseToolVendor(options.vendor, "tool_search_call"),
                });
                yield {
                    type: "tool_call_end",
                    callId,
                    arguments: argumentsJson,
                };
            }
            activeItems.delete(event.output_index);
            continue;
        }

        if (event.type === "response.incomplete") {
            const reason = event.response.incomplete_details?.reason ?? "unknown";
            for (const [outputIndex, item] of (event.response.output ?? []).entries()) {
                responseItems.set(outputIndex, JSON.stringify(item));
            }
            for (const [outputIndex, activeItem] of activeItems) {
                if (
                    (activeItem.type !== "function_call" &&
                        activeItem.type !== "custom_tool_call" &&
                        activeItem.type !== "tool_search_call") ||
                    activeItem.callId === undefined ||
                    activeItem.name === undefined ||
                    toolCalls.some((toolCall) => toolCall.callId === activeItem.callId)
                ) {
                    continue;
                }
                const argumentsJson = activeItem.argumentsJson ?? "";
                const vendorType =
                    activeItem.type === "custom_tool_call"
                        ? "custom_tool_call"
                        : activeItem.type === "tool_search_call"
                          ? "tool_search_call"
                          : "function_call";
                toolCalls.push({
                    callId: activeItem.callId,
                    name: activeItem.name,
                    ...(activeItem.namespace === undefined
                        ? {}
                        : { namespace: activeItem.namespace }),
                    arguments: argumentsJson,
                    incomplete: true,
                    vendor: responseToolVendor(options.vendor, vendorType),
                });
                yield {
                    type: "tool_call_end",
                    callId: activeItem.callId,
                    arguments: argumentsJson,
                    incomplete: true,
                };
                activeItems.delete(outputIndex);
            }
            usage = toSessionCacheUsage(event.response.usage);
            if (usage.totalTokens > 0) {
                yield { type: "token_usage", usage };
            }
            if (reason === "max_output_tokens") {
                yield { type: "done", state: "length" };
                return {
                    assistantText,
                    encryptedReasoning,
                    responseItems: [...responseItems.entries()]
                        .sort(([left], [right]) => left - right)
                        .map(([, item]) => item),
                    stopReason: "length",
                    toolCalls,
                    usage,
                };
            }
            throw new Error(`Incomplete response returned, reason: ${reason}`);
        }

        if (event.type === "response.completed") {
            for (const [outputIndex, item] of (event.response.output ?? []).entries()) {
                responseItems.set(outputIndex, JSON.stringify(item));
            }
            for (const [outputIndex, activeItem] of activeItems) {
                // A hosted call always finishes inside its own response, so a still-open one only
                // means we never saw its done event. Close it rather than leave it running.
                if (
                    activeItem.type !== "server_tool_call" ||
                    activeItem.callId === undefined ||
                    activeItem.name === undefined
                ) {
                    continue;
                }
                yield {
                    type: "server_tool_call_end",
                    callId: activeItem.callId,
                    name: activeItem.name,
                    arguments: activeItem.argumentsJson ?? "",
                };
                activeItems.delete(outputIndex);
            }
            for (const [outputIndex, activeItem] of activeItems) {
                if (
                    (activeItem.type !== "function_call" &&
                        activeItem.type !== "custom_tool_call" &&
                        activeItem.type !== "tool_search_call") ||
                    activeItem.callId === undefined ||
                    activeItem.name === undefined
                ) {
                    continue;
                }
                const completedItem = (event.response.output ?? []).find(
                    (item) =>
                        (item.type === "function_call" ||
                            item.type === "custom_tool_call" ||
                            item.type === "tool_search_call") &&
                        item.call_id === activeItem.callId,
                );
                const vendorType =
                    activeItem.type === "custom_tool_call"
                        ? "custom_tool_call"
                        : activeItem.type === "tool_search_call"
                          ? "tool_search_call"
                          : "function_call";
                const argumentsJson =
                    completedItem?.type === "custom_tool_call"
                        ? completedItem.input
                        : completedItem?.type === "function_call"
                          ? completedItem.arguments
                          : completedItem?.type === "tool_search_call"
                            ? JSON.stringify(completedItem.arguments)
                            : (activeItem.argumentsJson ?? "");
                toolCalls.push({
                    callId: activeItem.callId,
                    name: activeItem.name,
                    ...(activeItem.namespace === undefined
                        ? {}
                        : { namespace: activeItem.namespace }),
                    arguments: argumentsJson,
                    vendor: responseToolVendor(options.vendor, vendorType),
                });
                yield {
                    type: "tool_call_end",
                    callId: activeItem.callId,
                    arguments: argumentsJson,
                };
                activeItems.delete(outputIndex);
            }
            usage = toSessionCacheUsage(event.response.usage);
            yield { type: "token_usage", usage };
            yield {
                type: "done",
                state: sawToolUse ? "tool_call" : "normal",
            };
            return {
                assistantText,
                encryptedReasoning,
                responseItems: [...responseItems.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, item]) => item),
                stopReason: sawToolUse ? "tool_use" : "stop",
                toolCalls,
                usage,
            };
        }

        if (event.type === "error") {
            throw responseStreamError(event, options.failureMessage);
        }

        if (event.type === "response.failed") {
            throw responseStreamError(event, options.failureMessage);
        }
    }

    if (options.requireTerminalEvent) throw new Error("Response stream closed before completion.");
    yield { type: "token_usage", usage };
    yield {
        type: "done",
        state: sawToolUse ? "tool_call" : "normal",
    };
    return {
        assistantText,
        encryptedReasoning,
        responseItems: [...responseItems.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, item]) => item),
        stopReason: sawToolUse ? "tool_use" : "stop",
        toolCalls,
        usage,
    };
}

/**
 * Names the hosted tool behind an output item the provider executed itself.
 *
 * Two shapes reach us. A hosted search with its own item type is unambiguous. Grok's X search
 * instead reports its backend sub-calls as ordinary custom tool calls, so the only sound signal
 * is that the client never declared that tool: a call the client cannot execute, and is never
 * asked to answer, was answered by the provider. Function calls are deliberately excluded, since
 * an undeclared function name is a model mistake the model still needs to hear about.
 */
function serverExecutedItemName(
    item: unknown,
    clientToolNames: ReadonlySet<string> | undefined,
): string | undefined {
    const { type, name } = asOutputItem(item);
    if (type === "web_search_call") return "web_search";
    if (type !== "custom_tool_call" || name === undefined) return undefined;
    return clientToolNames !== undefined && !clientToolNames.has(name) ? name : undefined;
}

/**
 * Identifies a hosted call. Grok's X search carries a `call_id` and its web search only an `id`;
 * the output index stands in for anything that reports neither, so two concurrent calls can never
 * collide under one empty identifier.
 */
function serverToolCallId(item: unknown, outputIndex: number): string {
    const { call_id, id } = asOutputItem(item);
    return call_id ?? id ?? `server_tool_call_${outputIndex}`;
}

function serverToolCallArguments(item: unknown): string {
    const { input, action } = asOutputItem(item);
    if (typeof input === "string") return input;
    return action === undefined ? "" : JSON.stringify(action);
}

/** The few fields a hosted call carries, across the item shapes that can hold one. */
function asOutputItem(item: unknown): {
    type?: string;
    name?: string;
    id?: string;
    call_id?: string;
    input?: string;
    action?: unknown;
} {
    return item as { type?: string };
}

function responseToolVendor(
    vendor: "codex" | "grok" | "responses" | undefined,
    type: ResponsesToolCallType,
): ResponsesToolVendor {
    const provider = vendor ?? "grok";
    return type === "tool_search_call"
        ? { provider, type, execution: "client" }
        : { provider, type };
}

function isIncompleteOutputItem(item: unknown): boolean {
    return (
        typeof item === "object" &&
        item !== null &&
        "status" in item &&
        item.status === "incomplete"
    );
}
