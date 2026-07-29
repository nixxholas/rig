import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import { assistantMessageToAgentMessage } from "./assistantMessageToAgentMessage.js";
import { boundToolResultBlocks } from "./boundToolResultBlocks.js";
import { createErrorToolResultBlock } from "./createErrorToolResultBlock.js";
import { createToolResultBlock } from "./createToolResultBlock.js";
import type { AgentContext } from "./context/AgentContext.js";
import type { BashSessionActivity } from "./context/BashContext.js";
import { isContextWindowExceededError } from "./isContextWindowExceededError.js";
import { isInvalidImageRequestError } from "./isInvalidImageRequestError.js";
import { normalizeToolCallArguments } from "./normalizeToolCallArguments.js";
import { prepareProviderMessageImages } from "./prepareProviderMessageImages.js";
import { presentToolCall, type PresentedToolCall } from "./presentToolCall.js";
import { replaceLastTurnToolResultImages } from "./replaceLastTurnToolResultImages.js";
import { finalizeCompactionMessage } from "./compaction/finalizeCompactionMessage.js";
import { systemMessageToText } from "./systemMessageToText.js";
import { ABORTED_BY_SIGNAL, raceWithAbort } from "../utils/raceWithAbort.js";
import { createProviderPrompt, type ProviderPrompt } from "./prompt/createSystemPrompt.js";
import { ToolLockManager } from "./ToolLockManager.js";
import { toToolExecutionEndResult } from "./toToolExecutionEndResult.js";
import { errorToMessage } from "../errorToMessage.js";
import type {
    AgentBlock,
    AgentMessage,
    AnyDefinedTool,
    CompactionMessage,
    ContentBlock,
    Message,
    ToolResultBlock,
    UserMessage,
} from "./types.js";
import type {
    AssistantContent as ProviderAssistantContent,
    AssistantMessage as ProviderAssistantMessage,
    AssistantMessageEvent,
    Context as ProviderContext,
    Message as ProviderMessage,
    Model,
    Provider,
    ProviderAssistantMessageEvent,
    ServiceTier,
    StopReason,
    StreamOptions,
    Tool as ProviderTool,
    ToolCall as ProviderToolCall,
    ToolResultContent as ProviderToolResultContent,
    ToolResultMessage as ProviderToolResultMessage,
    Usage,
    UserContent as ProviderUserContent,
} from "@slopus/rig-execution";
import { toLocalDate } from "../executor/toLocalDate.js";
import {
    AutoPermissionDenialCircuitBreaker,
    describeAutoPermissionDenial,
    reviewAutoPermission,
    type AutoPermissionReview,
    type AutoPermissionRisk,
    type AutoPermissionUserAuthorization,
    type PermissionReviewAgent,
    type PermissionReviewTranscript,
} from "../permissions/index.js";
import type { DebugLog } from "../debug/index.js";
import type { DurableSkillDefinition } from "../external-skills/types.js";
import { resolveModelImageProfile } from "./resolveModelImageProfile.js";
import { toExecutorTool } from "./tools/toExecutorTool.js";

export interface RunAgentLoopOptions {
    /** Allows a dedicated permission reviewer to use the provider's hidden reviewer model. */
    allowReviewerModel?: boolean;
    appendSystemPrompt?: string;
    systemPrompt?: string;
    debug?: DebugLog;
    provider: Provider;
    /** Provider whose session is isolated from the coding agent and has no tools. */
    /** Lazily returns the sister agent that reviews Auto permission decisions. */
    permissionReviewAgent?: () => PermissionReviewAgent;
    modelId: string;
    effort?: string;
    serviceTier?: ServiceTier;
    tools: readonly AnyDefinedTool[];
    durableSkills?: readonly DurableSkillDefinition[];
    instructions?: string;
    messages: readonly Message[];
    /** Model-facing history, when the visible transcript has been compacted. */
    contextMessages?: readonly Message[];
    compactContext?: (
        messages: readonly Message[],
        options: {
            createProviderContext: (messages: readonly Message[]) => Promise<ProviderContext>;
            force: boolean;
            reportedTokens?: number;
        },
    ) => Promise<
        | {
              compacted: boolean;
              compactionMessage?: CompactionMessage;
              contextMessages: readonly Message[];
          }
        | undefined
    >;
    signal?: AbortSignal;
    sessionId?: string;
    startDate?: string;
    idFactory?: () => string;
    now?: () => number;
    onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
    onMessage?: (message: Message) => void | Promise<void>;
    /** Checkpoints model-only context before a recovery inference begins. */
    onContextChanged?: (messages: readonly Message[]) => void | Promise<void>;
    takeSteering?: () => readonly UserMessage[];
    /** Returns the signal aborted by the next scheduled steering message. */
    getSteeringSignal?: () => AbortSignal;
    context: AgentContext;
}

export type AgentLoopEvent =
    | AssistantMessageEvent
    | {
          type: "context_compaction_started";
          compactionId: string;
          estimatedTokensBefore: number;
          reason: "context_window" | "manual" | "threshold";
      }
    | {
          type: "context_compacted";
          compactionId: string;
          compactedMessageCount: number;
          elapsedMs: number;
          estimatedTokensAfter: number;
          estimatedTokensBefore: number;
          reason: "context_window" | "manual" | "threshold";
      }
    | {
          type: "context_compaction_finished";
          compactionId: string;
          elapsedMs: number;
          status: "cancelled" | "completed" | "failed";
      }
    | {
          type: "inference_iteration_start";
          iteration: number;
          messageId: string;
      }
    | {
          type: "steering_applied";
          messageIds: readonly string[];
      }
    | {
          type: "tool_execution_start";
          toolCall: PresentedToolCall;
      }
    | {
          type: "tool_execution_end";
          result: Pick<
              ToolResultBlock,
              | "display"
              | "failure"
              | "isError"
              | "presentation"
              | "toolCallId"
              | "toolName"
              | "type"
          >;
      }
    | {
          type: "tool_execution_progress";
          display: string;
          toolCallId: string;
      }
    | {
          type: "tool_execution_status";
          status: string;
          toolCallId: string;
      }
    | {
          type: "permission_review";
          action: string;
          decision: "allow" | "deny";
          reason: string;
          risk: AutoPermissionRisk;
          toolCallId: string;
          /** The reviewer's own reasoning, tool calls, and token usage for this verdict. */
          transcript?: PermissionReviewTranscript;
          userAuthorization: AutoPermissionUserAuthorization;
      }
    | {
          type: "permission_denial_limit_reached";
          reason: string;
      }
    | {
          type: "background_processes_changed";
          processes?: readonly BashSessionActivity[];
          running: number;
      }
    | {
          type: "background_processes_stopped";
          count: number;
      };

type PreparedToolPermission =
    | { kind: "skip" }
    | { kind: "error"; result: ToolResultBlock }
    | {
          action: string;
          kind: "review";
          review: AutoPermissionReview;
      };

interface AgentLoopOutcome {
    messages: readonly Message[];
    contextMessages: readonly Message[];
}

/**
 * A failed run always carries the text that explains the failure, so no exit path can
 * report an error the session and the transcript are unable to describe.
 */
export type AgentLoopResult =
    | (AgentLoopOutcome & { errorMessage: string; stopReason: "error" })
    | (AgentLoopOutcome & { errorMessage?: never; stopReason: Exclude<StopReason, "error"> });

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
    const model = findModel(options.provider, options.modelId, options.allowReviewerModel === true);
    const idFactory = options.idFactory ?? createId;
    const now = options.now ?? Date.now;
    const startDate = options.startDate ?? toLocalDate(now());
    const transcript: Message[] = [...options.messages];
    const contextTranscript: Message[] = [...(options.contextMessages ?? options.messages)];
    const providerMessages = toProviderMessages(contextTranscript, {
        model,
        now,
        providerId: options.provider.id,
    });
    const providerPrompt = await createProviderPrompt({
        ...(options.appendSystemPrompt !== undefined
            ? { appendSystemPrompt: options.appendSystemPrompt }
            : {}),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        provider: options.provider,
        model,
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        messages: contextTranscript,
        context: options.context,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        tools: options.tools,
        ...(options.durableSkills === undefined ? {} : { durableSkills: options.durableSkills }),
    });
    const providerTools = options.tools.map(toExecutorTool);
    const toolsByName = new Map(
        options.tools.map((tool) => [toolDispatchKey(tool.name, tool.namespace?.name), tool]),
    );
    const toolContext = options.context;
    const toolLocks = new ToolLockManager();
    const compactCurrentContext = (compaction: { force: boolean; reportedTokens?: number }) =>
        compactLoopContext({
            compaction,
            contextTranscript,
            model,
            now,
            options,
            providerMessages,
            providerTools,
            providerPrompt,
            transcript,
        });

    const permissionDenials = new AutoPermissionDenialCircuitBreaker();
    let iteration = 0;
    let contextOverflowRecoveryAttempted = false;
    for (;;) {
        if (options.signal?.aborted) {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: "aborted",
            };
        }

        iteration += 1;
        const messageId = idFactory();
        await options.onEvent?.({
            type: "inference_iteration_start",
            iteration,
            messageId,
        });

        let assistantMessage: ProviderAssistantMessage;
        let pendingStartEvent: AgentLoopEvent | undefined;
        let deferredErrorEvents: AgentLoopEvent[] = [];
        const rigToolCallIds = new Map<number, string>();
        try {
            const preparedProviderMessages = await prepareProviderMessageImages(
                providerMessages,
                resolveModelImageProfile(model),
            );
            const stream = options.provider.stream(
                model,
                toProviderContext(providerPrompt, preparedProviderMessages, providerTools),
                toStreamOptions(options, startDate),
            );
            const iterator = stream[Symbol.asyncIterator]();
            const consume = async () => {
                for (;;) {
                    const next = await iterator.next();
                    if (next.done) break;
                    if (options.signal?.aborted) {
                        throw new Error("Provider stream was aborted.");
                    }
                    const event = identifyAssistantMessageEvent(
                        assignRigToolCallEventIds(next.value, rigToolCallIds, idFactory),
                        messageId,
                    );
                    if (event.type === "start") {
                        pendingStartEvent = event;
                        continue;
                    }
                    if (event.type === "error") {
                        deferredErrorEvents.push(event);
                        continue;
                    }
                    if (pendingStartEvent !== undefined) {
                        await options.onEvent?.(pendingStartEvent);
                        pendingStartEvent = undefined;
                    }
                    await options.onEvent?.(event);
                }
                return assignRigToolCallIds(await stream.result(), rigToolCallIds, idFactory);
            };
            const outcome = await raceWithAbort(consume(), options.signal);
            if (outcome === ABORTED_BY_SIGNAL) {
                void Promise.resolve(iterator.return?.()).catch(() => undefined);
                await appendSteering(options, transcript, contextTranscript, providerMessages, now);
                return {
                    messages: transcript,
                    contextMessages: contextTranscript,
                    stopReason: "aborted",
                };
            }
            assistantMessage = outcome;
        } catch (error) {
            if (options.signal?.aborted) {
                await appendSteering(options, transcript, contextTranscript, providerMessages, now);
                return {
                    messages: transcript,
                    contextMessages: contextTranscript,
                    stopReason: "aborted",
                };
            }

            if (isInvalidImageRequestError(error)) {
                const replacements = replaceLastTurnToolResultImages(transcript, "Invalid image");
                if (replacements.length > 0) {
                    replaceLastTurnToolResultImages(contextTranscript, "Invalid image");
                    providerMessages.splice(
                        0,
                        providerMessages.length,
                        ...toProviderMessages(contextTranscript, {
                            model,
                            now,
                            providerId: options.provider.id,
                        }),
                    );
                    for (const replacement of replacements) {
                        await options.onMessage?.(replacement);
                    }
                    continue;
                }
            }

            if (!contextOverflowRecoveryAttempted && isContextWindowExceededError(error)) {
                contextOverflowRecoveryAttempted = true;
                if (await compactCurrentContext({ force: true })) {
                    continue;
                }
            }

            throw error;
        }

        if (isInvalidImageRequestError(assistantMessage)) {
            const replacements = replaceLastTurnToolResultImages(transcript, "Invalid image");
            if (replacements.length > 0) {
                replaceLastTurnToolResultImages(contextTranscript, "Invalid image");
                providerMessages.splice(
                    0,
                    providerMessages.length,
                    ...toProviderMessages(contextTranscript, {
                        model,
                        now,
                        providerId: options.provider.id,
                    }),
                );
                for (const replacement of replacements) {
                    await options.onMessage?.(replacement);
                }
                continue;
            }
        }

        if (
            assistantMessage.stopReason === "error" &&
            !contextOverflowRecoveryAttempted &&
            isContextWindowExceededError(assistantMessage)
        ) {
            contextOverflowRecoveryAttempted = true;
            if (await compactCurrentContext({ force: true })) {
                continue;
            }
        }

        if (pendingStartEvent !== undefined) {
            await options.onEvent?.(pendingStartEvent);
        }
        for (const event of deferredErrorEvents) {
            await options.onEvent?.(event);
        }

        providerMessages.push(assistantMessage);

        const toolCalls = assistantMessage.content
            .filter(isProviderToolCall)
            .map((toolCall) =>
                normalizeToolCallArguments(toolCall, resolveTool(toolCall, toolsByName)),
            );
        const normalizedToolCalls = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
        const presentedToolCalls = new Map(
            toolCalls.map((toolCall) => [
                toolCall.id,
                presentToolCall(toolCall, options.tools, toolContext),
            ]),
        );
        const agentMessage = assistantMessageToAgentMessage(
            {
                ...assistantMessage,
                content: assistantMessage.content.map((content) =>
                    content.type === "toolCall"
                        ? (normalizedToolCalls.get(content.id) ?? content)
                        : content,
                ),
            },
            messageId,
            {
                providerId: options.provider.id,
                requestedModelId: model.id,
            },
            (toolCall) => presentedToolCalls.get(toolCall.id)?.presentation,
        );
        const finalizedCompaction = finalizeCompactionMessage(
            contextTranscript,
            transcript,
            assistantMessage.usage,
        );
        if (finalizedCompaction !== undefined) {
            await options.onMessage?.(finalizedCompaction);
        }
        transcript.push(agentMessage);
        contextTranscript.push(agentMessage);
        await options.onMessage?.(agentMessage);

        const incompleteToolCalls = toolCalls.filter((toolCall) => toolCall.incomplete === true);
        if (assistantMessage.stopReason === "length" && incompleteToolCalls.length > 0) {
            await appendNonExecutedToolResults({
                toolCalls: incompleteToolCalls,
                transcript,
                contextTranscript,
                providerMessages,
                idFactory,
                now,
                onEvent: options.onEvent,
                onMessage: options.onMessage,
                message: "The tool call was interrupted because the model reached its output limit.",
            });
        }

        if (assistantMessage.stopReason === "aborted") {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (assistantMessage.stopReason === "error") {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                errorMessage: assistantMessage.errorMessage ?? "The model response failed.",
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (assistantMessage.stopReason !== "toolUse") {
            if (assistantMessage.endTurn === false) {
                await compactCurrentContext({
                    force: false,
                    reportedTokens: contextTokens(assistantMessage.usage),
                });
                await appendSteering(options, transcript, contextTranscript, providerMessages, now);
                continue;
            }
            if (
                (await appendSteering(
                    options,
                    transcript,
                    contextTranscript,
                    providerMessages,
                    now,
                )) > 0
            ) {
                continue;
            }
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (toolCalls.length === 0) {
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (options.signal?.aborted) {
            const interrupted = await appendInterruptedToolResults({
                toolCalls,
                toolsByName,
                transcript,
                contextTranscript,
                providerMessages,
                idFactory,
                now,
                onEvent: options.onEvent,
                onMessage: options.onMessage,
            });
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return interrupted;
        }

        const preparedPermissionEntries = await raceWithAbort(
            (async () => {
                const entries: [string, PreparedToolPermission][] = [];
                for (const toolCall of toolCalls) {
                    entries.push([
                        toolCall.id,
                        await prepareToolPermission(toolCall, toolsByName, toolContext, {
                            messages: transcript,
                            onPermissionReview: (review) =>
                                options.signal?.aborted
                                    ? Promise.resolve()
                                    : ignoreOptionalFailure(() =>
                                          options.onEvent?.({
                                              type: "permission_review",
                                              toolCallId: toolCall.id,
                                              ...review,
                                          }),
                                      ),
                            ...(options.permissionReviewAgent === undefined
                                ? {}
                                : { permissionReviewAgent: options.permissionReviewAgent }),
                            ...(options.signal === undefined ? {} : { signal: options.signal }),
                        }),
                    ]);
                }
                return entries;
            })(),
            options.signal,
        );
        if (preparedPermissionEntries === ABORTED_BY_SIGNAL) {
            const interrupted = await appendInterruptedToolResults({
                toolCalls,
                toolsByName,
                transcript,
                contextTranscript,
                providerMessages,
                idFactory,
                now,
                onEvent: options.onEvent,
                onMessage: options.onMessage,
            });
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return interrupted;
        }
        const preparedPermissions = new Map(preparedPermissionEntries);
        // Auto never interrupts the user, so a turn that keeps being refused has to stop itself.
        let permissionDenialLimitReached = false;
        for (const [, prepared] of preparedPermissionEntries) {
            if (prepared.kind !== "review") continue;
            if (prepared.review.decision === "allow") {
                permissionDenials.recordAllowed();
                continue;
            }
            permissionDenialLimitReached = permissionDenials.recordDenial()
                ? true
                : permissionDenialLimitReached;
        }
        const executeToolCalls = (calls: readonly ProviderToolCall[]) => {
            type ToolExecutionOutcome = {
                completedBeforeAbort: boolean;
                result: ToolResultBlock;
                toolCall: ProviderToolCall;
            };
            const executionByAction = new Map<string, Promise<ToolExecutionOutcome>>();
            return Promise.all(
                calls.map(async (toolCall) => {
                    const action = sameBatchToolAction(toolCall);
                    const duplicate = executionByAction.get(action);
                    if (duplicate !== undefined) {
                        const outcome = await duplicate;
                        return {
                            ...outcome,
                            result: toolResultForCall(outcome.result, toolCall),
                            toolCall,
                        };
                    }
                    const execution = (async (): Promise<ToolExecutionOutcome> => {
                        const interrupted = () => ({
                            completedBeforeAbort: false,
                            result: interruptedToolResultBlock(toolCall, toolsByName),
                            toolCall,
                        });
                        const operation = (async () => {
                            if (options.signal?.aborted) return interrupted();
                            await ignoreOptionalFailure(() =>
                                options.debug?.record("tool-call", {
                                    iteration,
                                    toolCall,
                                }),
                            );
                            if (options.signal?.aborted) return interrupted();
                            await ignoreOptionalFailure(() =>
                                options.onEvent?.({
                                    type: "tool_execution_start",
                                    toolCall: presentedToolCalls.get(toolCall.id) ?? toolCall,
                                }),
                            );
                            if (options.signal?.aborted) return interrupted();
                            const preparedPermission = preparedPermissions.get(toolCall.id) ?? {
                                kind: "skip" as const,
                            };
                            return toolLocks.run(
                                resolveToolLockKeys(toolCall, toolsByName),
                                async () => {
                                    if (options.signal?.aborted) return interrupted();
                                    const tool = resolveTool(toolCall, toolsByName);
                                    const executionSignal = tool?.steerable
                                        ? combineAbortSignals(
                                              options.signal,
                                              options.getSteeringSignal?.(),
                                          )
                                        : options.signal;
                                    const result = await executeToolCall(
                                        toolCall,
                                        toolsByName,
                                        toolContext,
                                        {
                                            batchId: agentMessage.id,
                                            messages: transcript,
                                            model,
                                            now,
                                            toolCallIndex: toolCalls.indexOf(toolCall),
                                            onProgress: (display) => {
                                                if (options.signal?.aborted) return;
                                                void ignoreOptionalFailure(() =>
                                                    options.onEvent?.({
                                                        type: "tool_execution_progress",
                                                        display,
                                                        toolCallId: toolCall.id,
                                                    }),
                                                );
                                            },
                                            onStatus: (status) => {
                                                if (options.signal?.aborted) return;
                                                void ignoreOptionalFailure(() =>
                                                    options.onEvent?.({
                                                        type: "tool_execution_status",
                                                        status,
                                                        toolCallId: toolCall.id,
                                                    }),
                                                );
                                            },
                                            onPermissionReview: (review) =>
                                                options.signal?.aborted
                                                    ? Promise.resolve()
                                                    : ignoreOptionalFailure(() =>
                                                          options.onEvent?.({
                                                              type: "permission_review",
                                                              toolCallId: toolCall.id,
                                                              ...review,
                                                          }),
                                                      ),
                                            onRawResult: (rawResult) =>
                                                options.signal?.aborted
                                                    ? Promise.resolve()
                                                    : ignoreOptionalFailure(() =>
                                                          options.debug?.record("tool-raw-result", {
                                                              iteration,
                                                              rawResult,
                                                              toolCall,
                                                          }),
                                                      ),
                                            onError: (error) =>
                                                ignoreOptionalFailure(() =>
                                                    options.debug?.record("tool-error", {
                                                        error,
                                                        iteration,
                                                        toolCall,
                                                    }),
                                                ),
                                            provider: options.provider,
                                            preparedPermission,
                                            ...(executionSignal === undefined
                                                ? {}
                                                : { signal: executionSignal }),
                                        },
                                    );
                                    return {
                                        completedBeforeAbort: options.signal?.aborted !== true,
                                        result,
                                        toolCall,
                                    };
                                },
                            );
                        })();
                        const raced = await raceWithAbort(operation, options.signal);
                        const outcome = raced === ABORTED_BY_SIGNAL ? interrupted() : raced;
                        const durableResult = outcome.completedBeforeAbort
                            ? outcome.result
                            : interruptedToolResultBlock(toolCall, toolsByName);
                        await ignoreOptionalFailure(() =>
                            options.debug?.record("tool-result", {
                                iteration,
                                result: durableResult,
                                toolCall,
                            }),
                        );
                        await ignoreOptionalFailure(() =>
                            options.onEvent?.({
                                type: "tool_execution_end",
                                result: toToolExecutionEndResult(durableResult),
                            }),
                        );
                        await ignoreOptionalFailure(() =>
                            options.onEvent?.({
                                type: "background_processes_changed",
                                processes: toolContext.bash.activeSessions?.() ?? [],
                                running: toolContext.bash.activeSessionCount?.() ?? 0,
                            }),
                        );
                        return {
                            ...outcome,
                            result: durableResult,
                        };
                    })();
                    executionByAction.set(action, execution);
                    return execution;
                }),
            );
        };
        const immediateCalls = toolCalls.filter(
            (toolCall) => resolveTool(toolCall, toolsByName)?.execution !== "durable",
        );
        const durableCalls = toolCalls.filter(
            (toolCall) => resolveTool(toolCall, toolsByName)?.execution === "durable",
        );

        // Durable calls are an execution barrier. Finish and persist every immediate
        // result first, then publish all durable calls in parallel.
        for (const calls of [immediateCalls, durableCalls]) {
            if (calls.length === 0) continue;
            const outcomes = await executeToolCalls(calls);
            const toolResultBlocks = boundToolResultBlocks(
                outcomes.map((outcome) =>
                    options.signal?.aborted && !outcome.completedBeforeAbort
                        ? interruptedToolResultBlock(outcome.toolCall, toolsByName)
                        : outcome.result,
                ),
            );
            for (const resultBlock of toolResultBlocks) {
                providerMessages.push(toProviderToolResultMessage(resultBlock, now));
            }
            const toolResultMessage: AgentMessage = {
                role: "agent",
                id: idFactory(),
                blocks: toolResultBlocks,
            };
            transcript.push(toolResultMessage);
            contextTranscript.push(toolResultMessage);
            await options.onMessage?.(toolResultMessage);
        }
        if (options.signal?.aborted) {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: "aborted",
            };
        }
        if (permissionDenialLimitReached) {
            const reason = permissionDenials.describeStop();
            await ignoreOptionalFailure(() =>
                options.onEvent?.({ type: "permission_denial_limit_reached", reason }),
            );
            const stopMessage: AgentMessage = {
                role: "agent",
                id: idFactory(),
                blocks: [{ type: "text", text: reason }],
            };
            transcript.push(stopMessage);
            contextTranscript.push(stopMessage);
            await options.onMessage?.(stopMessage);
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: "stop",
            };
        }
        await compactCurrentContext({
            force: false,
            reportedTokens: contextTokens(assistantMessage.usage),
        });
        await appendSteering(options, transcript, contextTranscript, providerMessages, now);
    }
}

async function ignoreOptionalFailure(callback: () => void | Promise<void>): Promise<void> {
    try {
        await callback();
    } catch {
        // Optional telemetry and live observers cannot invalidate durable tool execution.
    }
}

async function compactLoopContext(options: {
    compaction: { force: boolean; reportedTokens?: number };
    contextTranscript: Message[];
    model: Model;
    now: () => number;
    options: RunAgentLoopOptions;
    providerMessages: ProviderMessage[];
    providerTools: readonly ProviderTool[];
    providerPrompt: ProviderPrompt;
    transcript: Message[];
}): Promise<boolean> {
    const result = await options.options.compactContext?.(options.contextTranscript, {
        ...options.compaction,
        createProviderContext: async (messages) => {
            const preparedMessages = await prepareProviderMessageImages(
                toProviderMessages(messages, {
                    model: options.model,
                    now: options.now,
                    providerId: options.options.provider.id,
                }),
                resolveModelImageProfile(options.model),
            );
            return toProviderContext(
                options.providerPrompt,
                preparedMessages,
                options.providerTools,
            );
        },
    });
    if (result?.compacted !== true) return false;
    if (result.compactionMessage === undefined) {
        throw new Error("Compaction completed without a durable compaction message.");
    }

    options.transcript.push(result.compactionMessage);
    await options.options.onMessage?.(result.compactionMessage);
    options.contextTranscript.splice(
        0,
        options.contextTranscript.length,
        ...result.contextMessages,
    );
    options.providerMessages.splice(
        0,
        options.providerMessages.length,
        ...toProviderMessages(options.contextTranscript, {
            model: options.model,
            now: options.now,
            providerId: options.options.provider.id,
        }),
    );
    return true;
}

function contextTokens(usage: Usage): number {
    return usage.input + usage.cacheRead + usage.cacheWrite;
}

async function appendSteering(
    options: RunAgentLoopOptions,
    transcript: Message[],
    contextTranscript: Message[],
    providerMessages: ProviderMessage[],
    now: () => number,
): Promise<number> {
    const steering = options.takeSteering?.() ?? [];
    for (const message of steering) {
        transcript.push(message);
        contextTranscript.push(message);
        providerMessages.push(toProviderUserMessage(message, now));
    }
    if (steering.length > 0) {
        await options.onEvent?.({
            messageIds: steering.map((message) => message.id),
            type: "steering_applied",
        });
    }
    return steering.length;
}

async function appendInterruptedToolResults(options: {
    toolCalls: readonly ProviderToolCall[];
    toolsByName: ReadonlyMap<string, AnyDefinedTool>;
    transcript: Message[];
    contextTranscript: Message[];
    providerMessages: ProviderMessage[];
    idFactory: () => string;
    now: () => number;
    onEvent: ((event: AgentLoopEvent) => void | Promise<void>) | undefined;
    onMessage: ((message: Message) => void | Promise<void>) | undefined;
}): Promise<AgentLoopResult> {
    const toolResultBlocks = options.toolCalls.map((toolCall) =>
        interruptedToolResultBlock(toolCall, options.toolsByName),
    );
    for (const resultBlock of toolResultBlocks) {
        await ignoreOptionalFailure(() =>
            options.onEvent?.({
                type: "tool_execution_end",
                result: toToolExecutionEndResult(resultBlock),
            }),
        );
    }
    for (const resultBlock of toolResultBlocks) {
        options.providerMessages.push(toProviderToolResultMessage(resultBlock, options.now));
    }

    const toolResultMessage: AgentMessage = {
        role: "agent",
        id: options.idFactory(),
        blocks: toolResultBlocks,
    };
    options.transcript.push(toolResultMessage);
    options.contextTranscript.push(toolResultMessage);
    await options.onMessage?.(toolResultMessage);

    return {
        messages: options.transcript,
        contextMessages: options.contextTranscript,
        stopReason: "aborted",
    };
}

async function appendNonExecutedToolResults(options: {
    toolCalls: readonly ProviderToolCall[];
    transcript: Message[];
    contextTranscript: Message[];
    providerMessages: ProviderMessage[];
    idFactory: () => string;
    now: () => number;
    onEvent: ((event: AgentLoopEvent) => void | Promise<void>) | undefined;
    onMessage: ((message: Message) => void | Promise<void>) | undefined;
    message: string;
}): Promise<void> {
    const toolResultBlocks = options.toolCalls.map((toolCall) =>
        createErrorToolResultBlock(toolCall, options.message, { kind: "interrupted" }),
    );
    for (const resultBlock of toolResultBlocks) {
        await ignoreOptionalFailure(() =>
            options.onEvent?.({
                type: "tool_execution_end",
                result: toToolExecutionEndResult(resultBlock),
            }),
        );
        options.providerMessages.push(toProviderToolResultMessage(resultBlock, options.now));
    }
    const toolResultMessage: AgentMessage = {
        role: "agent",
        id: options.idFactory(),
        blocks: toolResultBlocks,
    };
    options.transcript.push(toolResultMessage);
    options.contextTranscript.push(toolResultMessage);
    await options.onMessage?.(toolResultMessage);
}

function findModel(provider: Provider, modelId: string, allowReviewerModel: boolean): Model {
    const model =
        provider.models.find((candidate) => candidate.id === modelId) ??
        (allowReviewerModel && provider.reviewerModel?.id === modelId
            ? provider.reviewerModel
            : undefined);
    if (!model) {
        throw new Error(`Unknown model '${modelId}' for provider '${provider.id}'`);
    }

    return model;
}

function toStreamOptions(options: RunAgentLoopOptions, startDate: string): StreamOptions {
    return {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        startDate,
        ...(options.effort !== undefined ? { thinking: options.effort } : {}),
    };
}

function toProviderContext(
    providerPrompt: ProviderPrompt,
    messages: readonly ProviderMessage[],
    tools: readonly ProviderTool[],
): ProviderContext {
    return {
        ...providerPrompt,
        messages: [...messages],
        ...(tools.length > 0 ? { tools: [...tools] } : {}),
    };
}

export function toProviderMessages(
    messages: readonly Message[],
    options: {
        model: Model;
        now: () => number;
        providerId: string;
    },
): ProviderMessage[] {
    const providerMessages: ProviderMessage[] = [];

    for (const message of messages) {
        if (message.role === "system") {
            // A notice belongs in the conversation at the position it was raised. Each provider
            // resolves it into its own native shape, so it never becomes prompt content here.
            providerMessages.push({
                role: "system",
                content: systemMessageToText(message),
                sourceMessageId: message.id,
                timestamp: options.now(),
            });
            continue;
        }

        if (message.role === "user") {
            providerMessages.push(toProviderUserMessage(message, options.now));
            continue;
        }

        if (message.role === "compaction") {
            providerMessages.push(
                message.kind === "native" && message.providerId === options.providerId
                    ? {
                          role: "compaction",
                          content: message.content,
                          ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
                          timestamp: options.now(),
                      }
                    : {
                          role: "user",
                          content: [{ type: "text", text: message.summary }],
                          timestamp: options.now(),
                      },
            );
            continue;
        }

        providerMessages.push(...toProviderMessagesFromAgentMessage(message, options));
    }

    return providerMessages;
}

function toProviderUserMessage(
    message: UserMessage,
    now: () => number,
): ProviderMessage {
    return {
        role: "user",
        content: message.blocks.map(toProviderUserContent),
        sourceMessageId: message.id,
        ...(message.encryptedAgentMessage === undefined
            ? {}
            : { encryptedAgentMessage: message.encryptedAgentMessage }),
        ...(message.agentMessageTriggerTurn === undefined
            ? {}
            : { agentMessageTriggerTurn: message.agentMessageTriggerTurn }),
        timestamp: now(),
    };
}

function toProviderMessagesFromAgentMessage(
    message: AgentMessage,
    options: {
        model: Model;
        now: () => number;
        providerId: string;
    },
): ProviderMessage[] {
    const assistantContent: ProviderAssistantContent[] = [];
    const toolResultBlocks: ToolResultBlock[] = [];

    for (const block of message.blocks) {
        if (block.type === "tool_result") {
            toolResultBlocks.push(block);
            continue;
        }

        assistantContent.push(toProviderAssistantContent(block));
    }

    const stopReason: StopReason = assistantContent.some(isProviderToolCall) ? "toolUse" : "stop";

    return [
        ...(assistantContent.length > 0
            ? [
                  {
                      role: "assistant" as const,
                      content: assistantContent,
                      api: "rig",
                      provider: options.providerId,
                      model: options.model.id,
                      usage: zeroUsage(),
                      stopReason,
                      timestamp: options.now(),
                      ...(message.responseItems === undefined
                          ? {}
                          : { responseItems: message.responseItems }),
                  },
              ]
            : []),
        ...boundToolResultBlocks(toolResultBlocks).map((block) =>
            toProviderToolResultMessage(block, options.now),
        ),
    ];
}

function toProviderUserContent(block: ContentBlock): ProviderUserContent {
    if (block.type === "text") {
        return {
            type: "text",
            text: block.text,
        };
    }

    return {
        type: "image",
        data: block.data,
        mimeType: block.mediaType,
        ...(block.detail !== undefined ? { detail: block.detail } : {}),
    };
}

function toProviderToolResultContent(block: ContentBlock): ProviderToolResultContent {
    return toProviderUserContent(block);
}

function toProviderAssistantContent(
    block: Exclude<AgentBlock, ToolResultBlock>,
): ProviderAssistantContent {
    if (block.type === "text") {
        return {
            type: "text",
            text: block.text,
        };
    }

    if (block.type === "thinking") {
        return {
            type: "thinking",
            thinking: block.thinking,
            ...(block.encrypted !== undefined ? { encrypted: block.encrypted } : {}),
            ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        };
    }

    if (block.type === "tool_call") {
        return {
            type: "toolCall",
            id: block.id,
            ...(block.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: block.providerToolCallId }),
            name: block.name,
            ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
            arguments: block.arguments as Record<string, unknown>,
            ...(block.incomplete === true ? { incomplete: true } : {}),
            ...(block.kind === undefined ? {} : { kind: block.kind }),
            ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
        };
    }

    throw new Error("Assistant image blocks are not supported by providers");
}

function resolveToolLockKeys(
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
): readonly string[] {
    const tool = resolveTool(toolCall, toolsByName);
    if (tool === undefined || !Value.Check(tool.arguments, toolCall.arguments)) return [];
    return tool.locks.map((lock) =>
        typeof lock === "string" ? lock : lock(toolCall.arguments as never),
    );
}

function toProviderToolResultMessage(
    block: ToolResultBlock,
    now: () => number,
): ProviderToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: block.toolCallId,
        ...(block.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: block.providerToolCallId }),
        toolName: block.toolName,
        content: block.rendered.map(toProviderToolResultContent),
        isError: block.isError ?? false,
        timestamp: now(),
        ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
    };
}

async function prepareToolPermission(
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
    context: AgentContext,
    options: {
        messages: readonly Message[];
        onPermissionReview?: (review: {
            action: string;
            decision: "allow" | "deny";
            reason: string;
            risk: AutoPermissionRisk;
            transcript?: PermissionReviewTranscript;
            userAuthorization: AutoPermissionUserAuthorization;
        }) => void | Promise<void>;
        permissionReviewAgent?: () => PermissionReviewAgent;
        signal?: AbortSignal;
    },
): Promise<PreparedToolPermission> {
    const tool = resolveTool(toolCall, toolsByName);
    if (
        tool === undefined ||
        !Value.Check(tool.arguments, toolCall.arguments) ||
        context.permissions?.mode !== "auto"
    ) {
        return { kind: "skip" };
    }
    try {
        if (!(await tool.shouldReviewInAutoMode(toolCall.arguments as never, context))) {
            return { kind: "skip" };
        }
        const reviewAgent = options.permissionReviewAgent;
        if (reviewAgent === undefined) {
            // Auto without a reviewer must fall back to the user, never to silent execution.
            const action =
                tool.describeAutoPermissionAction?.(toolCall.arguments as never, context) ??
                `running ${tool.name}`;
            const review = {
                decision: "deny",
                denialKind: "unavailable",
                reason: "No automatic permission reviewer is available for this session.",
                risk: "medium",
                userAuthorization: "low",
            } as const;
            await options.onPermissionReview?.({ action, ...review });
            return { action, kind: "review", review };
        }
        if (tool.describeAutoPermissionAction === undefined) {
            return {
                kind: "error",
                result: createErrorToolResultBlock(
                    toolCall,
                    "This tool cannot request Auto approval because its permission action is not defined.",
                ),
            };
        }
        const action = tool.describeAutoPermissionAction(toolCall.arguments as never, context);
        const review = await reviewAutoPermission({
            action,
            args: toolCall.arguments,
            messages: options.messages,
            reviewer: reviewAgent(),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            toolName: tool.name,
        });
        await options.onPermissionReview?.({
            action,
            decision: review.decision,
            reason: review.reason,
            risk: review.risk,
            ...(review.transcript === undefined ? {} : { transcript: review.transcript }),
            userAuthorization: review.userAuthorization,
        });
        return { action, kind: "review", review };
    } catch (error) {
        const message = errorToMessage(error);
        return {
            kind: "error",
            result: createErrorToolResultBlock(toolCall, `Tool '${tool.name}' failed: ${message}`, {
                kind: "execution_failed",
                message,
            }),
        };
    }
}

async function executeToolCall(
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
    context: AgentContext,
    options: {
        batchId: string;
        messages: readonly Message[];
        model: Model;
        now: () => number;
        onProgress?: (display: string) => void;
        onStatus?: (status: string) => void;
        onPermissionReview?: (review: {
            action: string;
            decision: "allow" | "deny";
            reason: string;
            risk: AutoPermissionRisk;
            transcript?: PermissionReviewTranscript;
            userAuthorization: AutoPermissionUserAuthorization;
        }) => void | Promise<void>;
        onError?: (error: unknown) => void | Promise<void>;
        onRawResult?: (result: unknown) => void | Promise<void>;
        preparedPermission: PreparedToolPermission;
        provider: Provider;
        signal?: AbortSignal;
        toolCallIndex: number;
    },
): Promise<ToolResultBlock> {
    const tool = resolveTool(toolCall, toolsByName);
    if (!tool) {
        return createErrorToolResultBlock(
            toolCall,
            `Unknown tool '${toolCall.name}' requested by model`,
            { kind: "tool_unavailable" },
        );
    }

    if (!Value.Check(tool.arguments, toolCall.arguments)) {
        return createErrorToolResultBlock(toolCall, `Invalid arguments for tool '${tool.name}'`, {
            kind: "invalid_arguments",
        });
    }

    if (context.permissions === undefined) {
        return createErrorToolResultBlock(
            toolCall,
            "This action requires an available permission context.",
        );
    }

    if (
        tool.requiresAutoOrFullAccess &&
        context.permissions.mode !== "auto" &&
        context.permissions.mode !== "full_access"
    ) {
        return createErrorToolResultBlock(
            toolCall,
            "This action requires Auto or Full access because it can operate outside Rig's local sandbox.",
        );
    }

    try {
        if (options.preparedPermission.kind === "error") {
            return options.preparedPermission.result;
        }
        let runWithFullAccess = false;
        if (options.preparedPermission.kind === "review") {
            const { review } = options.preparedPermission;
            if (review.decision === "deny") {
                return createErrorToolResultBlock(
                    toolCall,
                    describeAutoPermissionDenial(options.preparedPermission.action, review),
                );
            }
            runWithFullAccess = await tool.shouldRunInFullAccessInAutoMode(
                toolCall.arguments as never,
                context,
            );
        }

        const execute = tool.execute as (
            args: unknown,
            context: AgentContext,
            options: {
                messages?: readonly Message[];
                model?: Model;
                onProgress?: (display: string) => void;
                onStatus?: (status: string) => void;
                provider?: Provider;
                providerToolCallId?: string;
                signal?: AbortSignal;
                toolBatchId?: string;
                toolCallId?: string;
                toolCallIndex?: number;
            },
        ) => Promise<unknown> | unknown;
        const executionOptions: {
            messages?: readonly Message[];
            model?: Model;
            onProgress?: (display: string) => void;
            onStatus?: (status: string) => void;
            provider?: Provider;
            providerToolCallId?: string;
            signal?: AbortSignal;
            toolBatchId?: string;
            toolCallId?: string;
            toolCallIndex?: number;
        } = {
            messages: options.messages,
            model: options.model,
            provider: options.provider,
            ...(toolCall.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: toolCall.providerToolCallId }),
            toolCallId: toolCall.id,
        };
        if (tool.execution === "durable") {
            executionOptions.toolBatchId = options.batchId;
            executionOptions.toolCallIndex = options.toolCallIndex;
        }
        if (options.onProgress !== undefined) executionOptions.onProgress = options.onProgress;
        if (options.onStatus !== undefined) executionOptions.onStatus = options.onStatus;
        if (options.signal !== undefined) executionOptions.signal = options.signal;
        const run = () => execute(toolCall.arguments, context, executionOptions);
        if (runWithFullAccess && context.permissions?.mode !== "auto") {
            if (context.permissions?.mode !== "full_access") {
                return createErrorToolResultBlock(
                    toolCall,
                    `Tool '${tool.name}' was not run because the permission mode changed before its Auto-approved full-access execution began.`,
                    { kind: "interrupted" },
                );
            }
            runWithFullAccess = false;
        }
        const result =
            runWithFullAccess && context.permissions !== undefined
                ? await context.permissions.runWithMode("full_access", run)
                : await run();
        options.signal?.throwIfAborted();
        await options.onRawResult?.(result);
        return createToolResultBlock(
            tool,
            toolCall.arguments,
            result,
            toolCall.id,
            toolCall.vendor,
            toolCall.providerToolCallId,
        );
    } catch (error) {
        await options.onError?.(error);
        if (options.signal?.aborted) {
            return createErrorToolResultBlock(
                toolCall,
                tool.interruptionMessage ?? "Interrupted by user.",
                { kind: "interrupted" },
            );
        }
        const message = errorToMessage(error);
        return createErrorToolResultBlock(toolCall, `Tool '${tool.name}' failed: ${message}`, {
            kind: "execution_failed",
            message,
        });
    }
}

/** One externally visible action, independent of provider-generated call ids. */
function sameBatchToolAction(toolCall: ProviderToolCall): string {
    try {
        return JSON.stringify([
            toolCall.name,
            toolCall.namespace ?? null,
            toolCall.kind ?? null,
            toolCall.arguments,
        ]);
    } catch {
        // Provider tool arguments are JSON in normal operation. If a custom
        // provider violates that contract, keep the calls distinct rather than
        // guessing that two opaque values describe the same action.
        return toolCall.id;
    }
}

/** Reuses one execution result while answering every provider call it represents. */
function toolResultForCall(result: ToolResultBlock, toolCall: ProviderToolCall): ToolResultBlock {
    const { providerToolCallId: _providerToolCallId, ...shared } = result;
    return {
        ...shared,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ...(toolCall.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: toolCall.providerToolCallId }),
    };
}

function combineAbortSignals(
    first: AbortSignal | undefined,
    second: AbortSignal | undefined,
): AbortSignal | undefined {
    if (first === undefined) return second;
    if (second === undefined || first === second) return first;
    return AbortSignal.any([first, second]);
}

function interruptedToolResultBlock(
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
): ToolResultBlock {
    const message =
        resolveTool(toolCall, toolsByName)?.interruptionMessage ?? "Interrupted by user.";
    return createErrorToolResultBlock(toolCall, message, { kind: "interrupted" });
}

function resolveTool(
    toolCall: Pick<ProviderToolCall, "name" | "namespace">,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
): AnyDefinedTool | undefined {
    return toolsByName.get(toolDispatchKey(toolCall.name, toolCall.namespace));
}

function toolDispatchKey(name: string, namespace: string | undefined): string {
    return `${namespace ?? ""}\u0000${name}`;
}

function isProviderToolCall(content: ProviderAssistantContent): content is ProviderToolCall {
    return content.type === "toolCall";
}

function assignRigToolCallIds(
    message: ProviderAssistantMessage,
    rigToolCallIds: Map<number, string>,
    idFactory: () => string,
): ProviderAssistantMessage {
    return {
        ...message,
        content: message.content.map((content, contentIndex) =>
            content.type === "toolCall"
                ? localizeToolCall(content, contentIndex, rigToolCallIds, idFactory)
                : content,
        ),
    };
}

function assignRigToolCallEventIds(
    event: ProviderAssistantMessageEvent,
    rigToolCallIds: Map<number, string>,
    idFactory: () => string,
): ProviderAssistantMessageEvent {
    if (event.type === "done") {
        return {
            ...event,
            message: assignRigToolCallIds(event.message, rigToolCallIds, idFactory),
        };
    }
    if (event.type === "error") {
        return {
            ...event,
            error: assignRigToolCallIds(event.error, rigToolCallIds, idFactory),
        };
    }
    if (!("partial" in event)) return event;
    const partial = assignRigToolCallIds(event.partial, rigToolCallIds, idFactory);
    if (event.type !== "toolcall_end") return { ...event, partial };
    const toolCall = partial.content[event.contentIndex];
    return toolCall?.type === "toolCall" ? { ...event, partial, toolCall } : { ...event, partial };
}

function identifyAssistantMessageEvent(
    event: ProviderAssistantMessageEvent,
    messageId: string,
): AssistantMessageEvent {
    return { ...event, messageId };
}

function localizeToolCall(
    toolCall: ProviderToolCall,
    contentIndex: number,
    rigToolCallIds: Map<number, string>,
    idFactory: () => string,
): ProviderToolCall {
    let rigId = rigToolCallIds.get(contentIndex);
    if (rigId === undefined) {
        rigId = idFactory();
        rigToolCallIds.set(contentIndex, rigId);
    }
    return {
        ...toolCall,
        id: rigId,
        providerToolCallId: toolCall.providerToolCallId ?? toolCall.id,
    };
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
}
