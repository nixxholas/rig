import { BaseSession } from "@/core/BaseSession.js";
import type { SessionCacheUsage } from "@/core/SessionCacheUsage.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import { isSessionErrorDone } from "@/core/SessionEvent.js";
import { isGrokAuthError } from "@/vendors/grok/errors/grokErrors.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { GrokCredential } from "@/vendors/VendorCredential.js";
import { GROK_INFERENCE_MAX_RETRIES } from "@/vendors/grok/impl/grokConstants.js";
import { GrokConnection } from "@/vendors/grok/impl/GrokConnection.js";
import { classifyGrokError } from "@/vendors/grok/errors/grokErrors.js";
import { countGrokUserQueries } from "@/vendors/grok/impl/grokMessages.js";
import { createGrokCompactionContinuation } from "@/vendors/grok/impl/grokCompaction.js";
import { createGrokCompactionPrompt } from "@/vendors/grok/impl/grokCompaction.js";
import {
    delayBeforeGrokRetry,
    grokErrorStatus,
    isRetryableGrokError,
} from "@/vendors/grok/impl/grokRetry.js";
import { extractGrokUserQuery } from "@/vendors/grok/impl/grokMessages.js";
import { findLastGrokUserQuery } from "@/vendors/grok/impl/grokMessages.js";
import { formatGrokCompactionSummary } from "@/vendors/grok/impl/grokCompaction.js";
import { isDegenerateGrokCompactionSummary } from "@/vendors/grok/impl/grokCompaction.js";
import { isGrokProjectInstructionsMessage } from "@/vendors/grok/impl/grokMessages.js";
import { isGrokImageStripError } from "@/vendors/grok/errors/grokErrors.js";
import { isGrokStateReminderMessage } from "@/vendors/grok/impl/grokMessages.js";
import { isGrokUserInfoMessage } from "@/vendors/grok/impl/grokMessages.js";
import { isRetryableGrokCompactionError } from "@/vendors/grok/errors/grokErrors.js";
import type { OpenAIResponseRunResult } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { waitForGrokCompactionRetry } from "@/vendors/grok/impl/waitForGrokCompactionRetry.js";
import { wrapGrokUserQuery } from "@/vendors/grok/impl/grokMessages.js";
import { resolveGrokModelConfiguration } from "@/vendors/grok/impl/resolveGrokModelConfiguration.js";
import { resolveGrokModelId } from "@/vendors/grok/impl/resolveGrokModelId.js";
import { stripGrokContextImages } from "@/vendors/grok/impl/stripGrokContextImages.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";

export interface GrokSessionOptions extends SessionOptions {
    credential: GrokCredential;
    endpoint: string;
    model?: string;
    /** Identifies this client upstream instead of reproducing the grok-build user agent. */
    userAgent?: string;
}

export class GrokSession extends BaseSession {
    readonly credential: GrokCredential;
    readonly endpoint: string;
    readonly model: string | undefined;
    readonly tools: readonly SessionTool[];

    private activeModel: string | undefined;
    private readonly connection: GrokConnection;
    private context: SessionContext;
    private readonly modelConfigurations:
        | Readonly<Record<string, SessionModelConfiguration>>
        | undefined;
    private turnIndex: number;
    private readonly userAgent: string | undefined;

    constructor(id: string, options: GrokSessionOptions) {
        super(id);
        this.credential = options.credential;
        this.context = { instructions: options.instructions, messages: [] };
        this.turnIndex = 0;
        this.endpoint = options.endpoint;
        this.model = options.model;
        this.activeModel = options.model;
        this.modelConfigurations = options.modelConfigurations;
        this.tools = options.tools ?? [];
        this.userAgent = options.userAgent;

        this.connection = new GrokConnection({
            baseUrl: this.endpoint,
            sessionId: this.id,
            token: () => this.credential.credential.token,
            tools: this.tools,
            ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        });
    }

    run(request: SessionRunRequest): SessionStream {
        return this.streamRun(request);
    }

    async compact(options: SessionCompactionOptions = {}): Promise<SessionCompaction> {
        const { signal } = options;
        const context: SessionContext =
            options.context === undefined
                ? {
                      ...this.context,
                      messages: [...this.context.messages],
                  }
                : {
                      instructions: this.context.instructions,
                      messages: [...options.context.messages],
                  };
        if (signal?.aborted) {
            return { status: "cancelled", context };
        }

        const model = this.activeModel ?? this.model;
        if (model === undefined) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "A model is required for Grok compaction.",
                context,
            };
        }
        const configured = resolveGrokModelConfiguration({
            context,
            defaultTools: this.tools,
            ...(this.modelConfigurations?.[model] === undefined
                ? {}
                : { modelConfiguration: this.modelConfigurations[model] }),
        });
        const compactionContext: SessionContext = {
            instructions: configured.context.instructions,
            messages: [
                ...configured.context.messages,
                {
                    role: "user",
                    content: createGrokCompactionPrompt(options.instructions),
                },
            ],
        };

        let completedAttempt: CompletedGrokCompactionAttempt | undefined;
        let lastInvalidKind: "invalid_summary" | "tool_call" = "invalid_summary";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const result = await this.runCompactionAttempt(
                compactionContext,
                model,
                configured.tools,
                signal,
            );
            if (result.status === "cancelled") return { status: "cancelled", context };
            if (result.status === "failed") {
                if (result.retryable && attempt < 3) {
                    await waitForGrokCompactionRetry(signal);
                    if (signal?.aborted) return { status: "cancelled", context };
                    continue;
                }
                return {
                    status: "failed",
                    kind: "inference_error",
                    message: result.message,
                    context,
                };
            }

            const invalidKind = result.emittedToolCall
                ? "tool_call"
                : isDegenerateGrokCompactionSummary(result.rawSummary)
                  ? "invalid_summary"
                  : undefined;
            if (invalidKind === undefined) {
                completedAttempt = result;
                break;
            }
            lastInvalidKind = invalidKind;
            if (attempt < 3) await waitForGrokCompactionRetry(signal);
            if (signal?.aborted) return { status: "cancelled", context };
        }
        if (completedAttempt === undefined) {
            return {
                status: "failed",
                kind: lastInvalidKind,
                message:
                    lastInvalidKind === "tool_call"
                        ? "Grok emitted tool calls in three compaction attempts."
                        : "Grok returned three compaction summaries shorter than 500 characters.",
                context,
            };
        }

        const { rawSummary, encryptedReasoning, usage } = completedAttempt;
        const summary = formatGrokCompactionSummary(rawSummary);

        const userInfo = context.messages.filter(isGrokUserInfoMessage).slice(0, 1);
        const projectInstructions = context.messages.filter(isGrokProjectInstructionsMessage);
        const latestUserMessage = findLastGrokUserQuery(context.messages);
        const query = latestUserMessage && extractGrokUserQuery(latestUserMessage);
        const preservedQuery =
            query === undefined
                ? []
                : [{ role: "user" as const, content: wrapGrokUserQuery(query) }];
        const preservedMessages: SessionContext["messages"] = [
            ...userInfo,
            ...projectInstructions,
            ...preservedQuery,
        ];
        const stateReminders = context.messages.filter(isGrokStateReminderMessage).slice(-1);
        this.context = {
            instructions: context.instructions,
            messages: [
                ...preservedMessages,
                {
                    role: "user",
                    content: createGrokCompactionContinuation(rawSummary),
                },
                ...stateReminders,
            ],
        };
        return {
            status: "completed",
            summary,
            ...(encryptedReasoning === undefined ? {} : { encryptedReasoning }),
            preservedMessages,
            ...(usage === undefined ? {} : { usage }),
            context: this.context,
        };
    }

    destroy(): void {
        this.connection.close();
    }

    private async *streamRun(request: SessionRunRequest): AsyncGenerator<SessionEvent> {
        const { abort } = request;
        const previousUserQueries = countGrokUserQueries(this.context.messages);
        const messages = [...request.context.messages];
        const nextUserQueries = countGrokUserQueries(messages);
        if (nextUserQueries > previousUserQueries) {
            this.turnIndex += nextUserQueries - previousUserQueries;
        }
        this.context = {
            instructions: this.context.instructions,
            messages,
        };
        const context = this.context;
        const requestedModel = request.model ?? this.activeModel ?? this.model;
        const model = requestedModel === undefined ? undefined : resolveGrokModelId(requestedModel);
        if (model === undefined) throw new Error("A model is required for Grok inference.");
        this.activeModel = model;
        const configured = resolveGrokModelConfiguration({
            context,
            defaultTools: this.tools,
            ...(this.modelConfigurations?.[model] === undefined
                ? {}
                : { modelConfiguration: this.modelConfigurations[model] }),
        });
        const effort = request.effort;

        if (abort?.aborted) {
            yield { type: "done", state: "cancelled" };
            return;
        }

        yield { type: "block_start" };
        const inference = this.streamInference({
            context: configured.context,
            model,
            tools: configured.tools,
            ...(effort === undefined ? {} : { effort }),
            ...(abort === undefined ? {} : { abort }),
            turnIndex: this.turnIndex,
        });
        let result: OpenAIResponseRunResult | undefined;
        let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
        for (;;) {
            const next = await inference.next();
            if (next.done) {
                result = next.value;
                break;
            }
            if (next.value.type === "done") {
                terminal = next.value;
            } else {
                yield next.value;
            }
        }
        if (abort?.aborted) {
            yield { type: "block_reset" };
            yield { type: "done", state: "cancelled" };
            return;
        }
        if (terminal?.state === "error") {
            yield { type: "block_reset" };
            yield terminal;
            return;
        }
        if (
            result !== undefined &&
            (result.assistantText.length > 0 ||
                result.encryptedReasoning !== undefined ||
                result.toolCalls.length > 0 ||
                result.responseItems.length > 0)
        ) {
            this.context = {
                instructions: this.context.instructions,
                messages: [
                    ...this.context.messages,
                    {
                        role: "assistant",
                        content: result.assistantText,
                        ...(result.encryptedReasoning === undefined
                            ? {}
                            : { encryptedReasoning: result.encryptedReasoning }),
                        ...(result.toolCalls.length === 0 ? {} : { toolCalls: result.toolCalls }),
                        ...(result.responseItems.length === 0
                            ? {}
                            : { responseItems: result.responseItems }),
                    },
                ],
            };
        }
        if (result !== undefined && result.responseItems.length > 0) {
            yield { type: "response_items", items: result.responseItems };
        }
        yield { type: "block_stop" };
        if (terminal !== undefined) yield terminal;
    }

    private async runCompactionAttempt(
        context: SessionContext,
        model: string,
        tools: readonly SessionTool[],
        signal?: AbortSignal,
    ): Promise<GrokCompactionAttempt> {
        let rawSummary = "";
        let encryptedReasoning: string | undefined;
        let usage: SessionCacheUsage | undefined;
        let emittedToolCall = false;
        try {
            for await (const event of this.streamInference({
                context,
                model,
                tools,
                ...(signal === undefined ? {} : { abort: signal }),
                compaction: true,
                retryAfterContent: true,
            })) {
                if (signal?.aborted) return { status: "cancelled" };
                if (event.type === "retrying") {
                    rawSummary = "";
                    encryptedReasoning = undefined;
                    usage = undefined;
                    emittedToolCall = false;
                    continue;
                }
                if (event.type === "text_delta") rawSummary += event.delta;
                if (
                    event.type === "tool_call_start" ||
                    event.type === "tool_call_delta" ||
                    event.type === "tool_call_end" ||
                    event.type === "server_tool_call_delta"
                ) {
                    emittedToolCall = true;
                }
                if (event.type === "encrypted_reasoning") encryptedReasoning = event.content;
                if (event.type === "token_usage") usage = event.usage;
                if (isSessionErrorDone(event)) {
                    return {
                        status: "failed",
                        message: `[${event.kind}] ${event.message}`,
                        retryable: isRetryableGrokCompactionError(event.message),
                    };
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                status: "failed",
                message,
                retryable: isRetryableGrokCompactionError(message),
            };
        }
        return {
            status: "completed",
            rawSummary,
            emittedToolCall,
            ...(encryptedReasoning === undefined ? {} : { encryptedReasoning }),
            ...(usage === undefined ? {} : { usage }),
        };
    }

    private async *streamInference(options: {
        context: SessionContext;
        model: string;
        tools?: readonly SessionTool[];
        effort?: SessionRunRequest["effort"];
        abort?: AbortSignal;
        turnIndex?: number;
        compaction?: boolean;
        retryAfterContent?: boolean;
    }): AsyncGenerator<SessionEvent, OpenAIResponseRunResult | undefined> {
        const { abort } = options;
        await this.refreshCredentialIfExpiring();
        let requestContext = options.context;
        let attempt = 0;
        let rateLimitRetries = 0;
        let responseContentBegun = false;
        let strippedImages = false;
        let refreshedCredential = false;

        for (;;) {
            if (abort?.aborted) {
                return;
            }

            try {
                const mapped = await this.connection.stream({
                    ...(abort === undefined ? {} : { abort }),
                    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
                    context: requestContext,
                    ...(options.effort === undefined ? {} : { effort: options.effort }),
                    model: options.model,
                    ...(options.tools === undefined ? {} : { tools: options.tools }),
                    ...(options.turnIndex === undefined ? {} : { turnIndex: options.turnIndex }),
                });
                for (;;) {
                    const next = await mapped.next();
                    if (next.done) return next.value;
                    const event = next.value;
                    if (
                        event.type === "text_delta" ||
                        event.type === "reasoning_delta" ||
                        event.type === "encrypted_reasoning" ||
                        event.type === "tool_call_start" ||
                        event.type === "tool_call_delta" ||
                        event.type === "tool_call_end" ||
                        event.type === "server_tool_call_delta"
                    ) {
                        responseContentBegun = true;
                    }

                    yield event;
                }
            } catch (error) {
                if (abort?.aborted) {
                    return;
                }

                const message = error instanceof Error ? error.message : String(error);
                const status = grokErrorStatus(error);
                const authError = isGrokAuthError({
                    message,
                    ...(status === undefined ? {} : { status }),
                });
                if (
                    authError &&
                    !refreshedCredential &&
                    !responseContentBegun &&
                    this.credential instanceof GrokSessionCredential
                ) {
                    refreshedCredential = true;
                    if (await this.credential.refreshAfterUnauthorized()) {
                        await this.connection.rebuild(false);
                        continue;
                    }
                }
                if (!strippedImages && isGrokImageStripError(error)) {
                    const stripped = stripGrokContextImages(requestContext);
                    if (stripped !== undefined) {
                        strippedImages = true;
                        requestContext = stripped;
                        continue;
                    }
                }
                const withinRateLimitBudget = status !== 429 || rateLimitRetries + 1 < 2;
                if (
                    (!responseContentBegun || options.retryAfterContent === true) &&
                    attempt + 1 < GROK_INFERENCE_MAX_RETRIES &&
                    withinRateLimitBudget &&
                    isRetryableGrokError(error)
                ) {
                    attempt += 1;
                    if (status === 429) rateLimitRetries += 1;
                    if (attempt === 1 && status !== 429) {
                        await this.connection.rebuild(true);
                    }
                    yield { type: "retrying", attempt, reason: message };
                    await delayBeforeGrokRetry(attempt, abort, error);
                    if (abort?.aborted) {
                        return;
                    }
                    continue;
                }

                yield {
                    type: "done",
                    state: "error",
                    kind: classifyGrokError(message),
                    message,
                    ...(authError ? { providerError: { type: "authentication" as const } } : {}),
                };
                return;
            }
        }
    }

    /** Renews an expiring session token so the request is not sent with a dead credential. */
    private async refreshCredentialIfExpiring(): Promise<void> {
        if (this.credential instanceof GrokSessionCredential) {
            await this.credential.ensureFresh();
        }
    }
}

interface CompletedGrokCompactionAttempt {
    status: "completed";
    rawSummary: string;
    emittedToolCall: boolean;
    encryptedReasoning?: string;
    usage?: SessionCacheUsage;
}

type GrokCompactionAttempt =
    | CompletedGrokCompactionAttempt
    | { status: "cancelled" }
    | { status: "failed"; message: string; retryable: boolean };
