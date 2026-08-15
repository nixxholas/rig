import { release } from "node:os";

import {
    areProviderModelsCompatible,
    type BaseProvider,
    type BaseSession,
    type SessionCompaction,
    type SessionAssistantBlock,
    type SessionContext,
    type SessionMessage,
    type SessionModelConfiguration,
} from "@slopus/happy-providers";
import { withLifetime, type Context as RuntimeContext } from "@steve.kite/stdlib";

import type { ExecutorEvent } from "@/ExecutorEvent.js";
import type {
    ExecutorModelProfile,
    ExecutorRunRequest,
    ExecutorSelection,
} from "@/ExecutorModelProfile.js";
import type { ExecutorProvider } from "@/ExecutorProvider.js";
import { DEFAULT_IDENTITY, type Identity } from "@/Identity.js";
import {
    createExecutorInferenceStream,
    toRigProviderSessionTools,
} from "@/createExecutorInferenceStream.js";
import { filterProviderCompatibleSessionTools } from "@/filterProviderCompatibleSessionTools.js";
import { reviewerModelForProvider } from "@/reviewerModelForProvider.js";
import { toSessionMessages } from "@/toSessionMessages.js";
import type { ExecutorEnvironment } from "@/prompts/ExecutorEnvironment.js";
import { assembleSystemPrompt } from "@/prompts/assembleSystemPrompt.js";
import type {
    AssistantContent,
    AssistantMessage,
    CompactionResult,
    Context,
    InferenceStream,
    Model,
    ProfileProviderType,
    ProfilePromptContext,
    RawQueryOptions,
    ServiceTier,
    StreamOptions,
} from "@/types.js";

export class Executor {
    readonly environment: ExecutorEnvironment;
    readonly identity: Identity;
    readonly providers: readonly ExecutorProvider[];
    readonly profiles: readonly ExecutorModelProfile[];
    private selectedProviderId: string;
    private active:
        | {
              contextInstructions: string | undefined;
              context: SessionContext;
              profile: ExecutorModelProfile;
              session: BaseSession;
              systemPrompt: string | undefined;
              toolsKey: string;
          }
        | undefined;
    private readonly profilesByKey = new Map<string, ExecutorModelProfile>();
    private readonly providersById = new Map<string, ExecutorProvider>();
    private readonly nativeProviders = new Map<string, Promise<BaseProvider>>();
    private inferencePending: Promise<void> = Promise.resolve();
    private sessionResolutionPending: Promise<void> = Promise.resolve();
    private sessionSequence = 0;
    private forceClosed = false;

    constructor(
        providers: readonly ExecutorProvider[],
        options: {
            environment?: ExecutorEnvironment;
            identity?: Identity;
        } = {},
    ) {
        this.environment = options.environment ?? {
            osVersion: release(),
            platform: process.platform,
            primaryWorkingDirectory: process.cwd(),
            shell: process.env.SHELL ?? "",
        };
        this.identity = { ...(options.identity ?? DEFAULT_IDENTITY) };
        this.providers = [...providers];
        for (const provider of providers) {
            if (this.providersById.has(provider.id)) {
                throw new Error(`Executor provider '${provider.id}' is configured more than once.`);
            }
            this.providersById.set(provider.id, provider);
            for (const profile of provider.profiles) {
                if (profile.providerId !== provider.id) {
                    throw new Error(
                        `Model '${profile.id}' belongs to '${profile.providerId}', not '${provider.id}'.`,
                    );
                }
                const key = selectionKey(profile);
                if (this.profilesByKey.has(key)) {
                    throw new Error(
                        `Executor model '${profile.id}' is configured more than once for '${provider.id}'.`,
                    );
                }
                this.profilesByKey.set(key, profile);
            }
        }
        this.profiles = [...this.profilesByKey.values()];
        const primary = providers[0];
        if (primary === undefined) throw new Error("Executor requires at least one provider.");
        this.selectedProviderId = primary.id;
    }

    get id(): string {
        return this.selectedProviderId;
    }

    get models(): readonly Model[] {
        return this.selectedProvider.profiles
            .filter((profile) => profile.hidden !== true)
            .map((profile) => profile.model);
    }

    get reviewerModel(): Model | undefined {
        return reviewerModelForProvider(this.selectedProvider.profiles);
    }

    reviewerModelFor(model: Model): Model | undefined {
        return reviewerModelForProvider(this.selectedProvider.profiles, model.id);
    }

    get serviceTiers(): readonly ServiceTier[] | undefined {
        return this.selectedProvider.serviceTiers;
    }

    get type(): ProfileProviderType {
        const type = this.selectedProvider.profiles[0]?.providerType;
        if (type === undefined || type === "gym") {
            throw new Error(
                `Executor provider '${this.selectedProviderId}' has no concrete coding-model type.`,
            );
        }
        return type;
    }

    get extendProfilePromptContext():
        | ((context: ProfilePromptContext) => ProfilePromptContext | Promise<ProfilePromptContext>)
        | undefined {
        return this.selectedProvider.extendProfilePromptContext;
    }

    get hasActiveSession(): boolean {
        return this.active !== undefined;
    }

    isolate(label: string): Executor {
        const isolated = new Executor(
            this.providers.map((provider) => {
                const { destroy: _destroy, ...lent } = provider.isolated?.() ?? provider;
                return { ...lent, sessionId: `${provider.sessionId ?? provider.id}:${label}` };
            }),
            {
                environment: this.environment,
                identity: this.identity,
            },
        );
        isolated.selectProvider(this.selectedProviderId);
        return isolated;
    }

    selectProvider(providerId: string): void {
        if (!this.providersById.has(providerId)) {
            throw new Error(`Executor provider '${providerId}' is not configured.`);
        }
        this.selectedProviderId = providerId;
    }

    async systemPrompt(
        selection: ExecutorSelection,
        contextInstructions?: string,
        systemPrompt?: string,
    ): Promise<string> {
        return assembleSystemPrompt({
            ...(contextInstructions === undefined ? {} : { contextInstructions }),
            environment: this.environment,
            identity: this.identity,
            profile: this.profile(selection),
            profiles: this.profiles,
            ...(systemPrompt === undefined ? {} : { systemPrompt }),
        });
    }

    /**
     * Asks one bounded question on the bare vendor provider.
     *
     * Everything the Executor normally contributes is deliberately absent: no model base prompt,
     * no environment description, no tools, and no share of the conversation the agent is holding.
     * The vendor session created here is its own, so this neither waits behind the agent's
     * inference nor disturbs the history that session has cached. The provider is resolved through
     * the same path agent inference uses, so it carries the same credentials and configuration.
     */
    async rawQuery(ctx: RuntimeContext, options: RawQueryOptions): Promise<string> {
        if (this.forceClosed) throw new Error("The executor is closed.");
        const profile = this.profile({ modelId: options.model.id, providerId: this.id });
        const provider = this.providersById.get(profile.providerId)!;
        const native = await this.resolveNative(provider, profile);
        const session = await native.session(options.sessionId, {
            instructions: options.instructions,
            tools: [],
        });
        try {
            let text = "";
            const operationCtx =
                options.signal === undefined ? ctx : withLifetime(ctx, options.signal);
            for await (const event of session.run(operationCtx, {
                context: {
                    instructions: options.instructions,
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: options.prompt }],
                        },
                    ],
                },
                effort: "off",
                model: profile.id,
            })) {
                if (event.type === "text_delta") text += event.delta;
                if (event.type === "block_reset") text = "";
                if (event.type !== "done") continue;
                // A failed or cancelled response carries no answer. Reporting the provider's own
                // failure is what keeps a broken title from looking like a malformed one.
                if (event.state === "error") throw new Error(event.message);
                if (event.state === "cancelled") {
                    throw new Error("The provider cancelled the response.");
                }
            }
            return text.trim();
        } finally {
            await session.destroy();
        }
    }

    stream(
        ctx: RuntimeContext,
        model: Model,
        context: Context,
        streamOptions?: StreamOptions,
    ): InferenceStream {
        const selection = { modelId: model.id, providerId: this.id };
        this.profile(selection);
        return createExecutorInferenceStream({
            ctx,
            context,
            executor: this,
            model,
            providerId: selection.providerId,
            ...(streamOptions === undefined ? {} : { streamOptions }),
        });
    }

    async *run(ctx: RuntimeContext, request: ExecutorRunRequest): AsyncGenerator<ExecutorEvent> {
        const releaseInference = await this.acquireInference();
        try {
            if (this.forceClosed) throw new Error("The executor is closed.");
            const profile = this.profile(request.selection);
            const resolution = await this.serializeSessionResolution(async () => {
                if (
                    this.active !== undefined &&
                    !areProviderModelsCompatible(
                        toCompatibilitySelection(this.active.profile),
                        toCompatibilitySelection(profile),
                    )
                ) {
                    return {
                        type: "reset_required" as const,
                        current: toSelection(this.active.profile),
                        requested: request.selection,
                        message: `Reset the executor before switching from '${this.active.profile.id}' to incompatible model '${profile.id}'.`,
                    };
                }

                const tools = request.tools ?? [];
                const instructions = assembleSystemPrompt({
                    ...(request.contextInstructions === undefined
                        ? {}
                        : { contextInstructions: request.contextInstructions }),
                    environment: this.environment,
                    identity: this.identity,
                    profile,
                    profiles: this.profiles,
                    ...(request.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: request.systemPrompt }),
                });
                const context = { ...request.context, instructions };
                const active = await this.resolveSession(
                    profile,
                    context,
                    request.contextInstructions,
                    request.systemPrompt,
                    tools,
                );
                active.context = context;
                return active;
            });
            if ("type" in resolution) {
                yield resolution;
                return;
            }

            const operationCtx =
                request.abort === undefined ? ctx : withLifetime(ctx, request.abort);
            yield* resolution.session.run(operationCtx, {
                context: resolution.context,
                ...(request.effort === undefined ? {} : { effort: request.effort }),
                model: profile.id,
                ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
                ...(request.structuredOutput === undefined
                    ? {}
                    : { structuredOutput: request.structuredOutput }),
            });
        } finally {
            releaseInference();
        }
    }

    async compact(
        ctx: RuntimeContext,
        options: {
            context: Context;
            instructions?: string;
            model: Model;
            signal?: AbortSignal;
        },
    ): Promise<CompactionResult> {
        const releaseInference = await this.acquireInference();
        try {
            const sourceContext = options.context;
            const profile = this.profile({ modelId: options.model.id, providerId: this.id });
            const contextInstructions = sourceContext.systemPrompt ?? "";
            const systemPrompt = sourceContext.systemPromptOverride;
            const tools = toRigProviderSessionTools(sourceContext.tools ?? [], {
                lockCodexCollaboration:
                    profile.providerType === "codex" && profile.id.startsWith("openai/"),
            });
            const instructions = assembleSystemPrompt({
                contextInstructions,
                environment: this.environment,
                identity: this.identity,
                profile,
                profiles: this.profiles,
                ...(systemPrompt === undefined ? {} : { systemPrompt }),
            });
            const context: SessionContext = {
                instructions,
                messages: toSessionMessages(sourceContext.messages),
            };
            const active = await this.serializeSessionResolution(async () => {
                const resolved = await this.resolveSession(
                    profile,
                    context,
                    contextInstructions,
                    systemPrompt,
                    tools,
                );
                resolved.context = context;
                return resolved;
            });
            const operationCtx =
                options.signal === undefined ? ctx : withLifetime(ctx, options.signal);
            const result = await active.session.compact(operationCtx, {
                context,
                ...(options.instructions === undefined
                    ? {}
                    : { instructions: options.instructions }),
                model: profile.id,
            });
            return toExecutionCompactionResult(result, sourceContext);
        } finally {
            releaseInference();
        }
    }

    async reset(selection?: ExecutorSelection): Promise<void> {
        if (selection !== undefined) this.profile(selection);
        const releaseInference = await this.acquireInference();
        try {
            await this.serializeSessionResolution(async () => {
                const active = this.active;
                this.active = undefined;
                if (active !== undefined) await active.session.destroy();
            });
        } finally {
            releaseInference();
        }
    }

    async destroy(): Promise<void> {
        try {
            await this.reset();
        } finally {
            await Promise.all(
                [...this.providersById.values()].map((provider) => provider.destroy?.()),
            );
        }
    }

    async close(): Promise<void> {
        await this.destroy();
    }

    /**
     * Tears down this executor's active provider session without entering its inference queue.
     *
     * Normal reset/close serialization protects conversational state. An isolated bounded query
     * has no future conversational state to preserve, and waiting behind an inference that ignored
     * abort would make its deadline ineffective.
     */
    forceClose(): Promise<void> | void {
        this.forceClosed = true;
        const active = this.active;
        this.active = undefined;
        return active?.session.destroy();
    }

    private profile(selection: ExecutorSelection): ExecutorModelProfile {
        const profile = this.profilesByKey.get(selectionKey(selection));
        if (profile === undefined) {
            throw new Error(
                `Executor model '${selection.modelId}' is not available for provider '${selection.providerId}'.`,
            );
        }
        return profile;
    }

    private async resolveSession(
        profile: ExecutorModelProfile,
        context: SessionContext,
        contextInstructions: string | undefined,
        systemPrompt: string | undefined,
        tools: readonly import("@slopus/happy-providers").SessionTool[],
    ) {
        if (this.forceClosed) throw new Error("The executor is closed.");
        const clientTools = filterProviderCompatibleSessionTools(tools);
        const provider = this.providersById.get(profile.providerId)!;
        const toolsKey = canonicalJson(clientTools);
        if (
            this.active !== undefined &&
            this.active.profile.providerId === profile.providerId &&
            nativeKey(provider, this.active.profile) === nativeKey(provider, profile) &&
            this.active.contextInstructions === contextInstructions &&
            this.active.systemPrompt === systemPrompt &&
            this.active.toolsKey === toolsKey
        ) {
            this.active.profile = profile;
            return this.active;
        }
        const previous = this.active;
        this.active = undefined;
        if (previous !== undefined) await previous.session.destroy();
        const modelConfigurations: Record<string, SessionModelConfiguration> = {};
        for (const candidate of provider.profiles) {
            const instructions = assembleSystemPrompt({
                ...(contextInstructions === undefined ? {} : { contextInstructions }),
                environment: this.environment,
                identity: this.identity,
                profile: candidate,
                profiles: this.profiles,
                ...(systemPrompt === undefined ? {} : { systemPrompt }),
            });
            // Sessions receive configuration only. The conversation history is owned by the
            // caller and arrives complete with every run, never at session creation.
            modelConfigurations[candidate.id] = {
                instructions,
                tools: clientTools,
            };
        }
        const sequence = ++this.sessionSequence;
        const sessionId =
            provider.sessionId === undefined
                ? `executor-${String(sequence)}`
                : sequence === 1
                  ? provider.sessionId
                  : `${provider.sessionId}-reset-${String(sequence)}`;
        const native = await this.resolveNative(provider, profile);
        const session = await native.session(sessionId, {
            instructions: context.instructions,
            modelConfigurations,
            tools: clientTools,
        });
        const resolved = {
            context,
            contextInstructions,
            profile,
            session,
            systemPrompt,
            toolsKey,
        };
        if (this.forceClosed) {
            await session.destroy();
            throw new Error("The executor is closed.");
        }
        return (this.active = resolved);
    }

    private async serializeSessionResolution<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.sessionResolutionPending;
        let release!: () => void;
        this.sessionResolutionPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private async acquireInference(): Promise<() => void> {
        const previous = this.inferencePending;
        let release!: () => void;
        this.inferencePending = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        return release;
    }

    private resolveNative(
        provider: ExecutorProvider,
        profile: ExecutorModelProfile,
    ): Promise<BaseProvider> {
        const key = `${provider.id}\0${nativeKey(provider, profile)}`;
        const existing = this.nativeProviders.get(key);
        if (existing !== undefined) return existing;
        const pending =
            typeof provider.native === "function"
                ? provider.native(profile)
                : Promise.resolve(provider.native);
        this.nativeProviders.set(key, pending);
        void pending.catch(() => {
            if (this.nativeProviders.get(key) === pending) {
                this.nativeProviders.delete(key);
            }
        });
        return pending;
    }

    private get selectedProvider(): ExecutorProvider {
        return this.providersById.get(this.selectedProviderId)!;
    }
}

function canonicalJson(value: unknown): string {
    const serialized = JSON.stringify(value, (_key, entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        return Object.fromEntries(
            Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
            ),
        );
    });
    if (serialized === undefined) throw new Error("Executor configuration is not JSON.");
    return serialized;
}

function nativeKey(provider: ExecutorProvider, profile: ExecutorModelProfile): string {
    return provider.nativeKey?.(profile) ?? provider.id;
}

function selectionKey(selection: ExecutorSelection | ExecutorModelProfile): string {
    const modelId = "modelId" in selection ? selection.modelId : selection.id;
    return `${selection.providerId}\0${modelId}`;
}

function toSelection(profile: ExecutorModelProfile): ExecutorSelection {
    return { modelId: profile.id, providerId: profile.providerId };
}

function toCompatibilitySelection(profile: ExecutorModelProfile) {
    return {
        modelId: profile.id,
        providerId: profile.providerId,
        providerType: profile.providerType,
    };
}

function toExecutionCompactionResult(
    result: SessionCompaction,
    sourceContext: Context,
): CompactionResult {
    if (result.status === "failed") return { ...result, context: sourceContext };
    const context = {
        ...sourceContext,
        messages: result.context.messages.map((message) =>
            sessionMessageToExecutionMessage(message, latestTimestamp(sourceContext.messages)),
        ),
    };
    if (result.status === "cancelled") return { ...result, context };
    return {
        status: "completed",
        context,
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        ...(result.compaction === undefined
            ? {}
            : {
                  compaction: {
                      role: "compaction",
                      content: result.compaction.content,
                      encryptedContent: result.compaction.encryptedContent,
                      ...(result.compaction.vendor === undefined
                          ? {}
                          : { vendor: result.compaction.vendor }),
                      timestamp: latestTimestamp(sourceContext.messages),
                  },
              }),
        usage: result.usage,
    };
}

function sessionMessageToExecutionMessage(
    message: SessionMessage,
    timestamp: number,
): Context["messages"][number] {
    if (message.role === "system") {
        return {
            role: "system",
            content: message.content.map((block) => block.text).join("\n"),
            timestamp,
        };
    }
    if (message.role === "compaction") {
        return {
            role: "compaction",
            content: message.content,
            encryptedContent: message.encryptedContent,
            ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            timestamp,
        };
    }
    if (message.role === "agent") {
        return {
            role: "user",
            content: "",
            encryptedAgentMessage: {
                author: message.author,
                recipient: message.recipient,
                header: message.header,
                encryptedContent: message.encryptedContent,
            },
            ...(message.agentMessageTriggerTurn === undefined
                ? {}
                : { agentMessageTriggerTurn: message.agentMessageTriggerTurn }),
            timestamp,
        };
    }
    if (message.role === "user") {
        const content = message.content.map((part) =>
            part.type === "text"
                ? { type: "text" as const, text: part.text }
                : {
                      type: "image" as const,
                      data: part.data,
                      mimeType: part.mimeType,
                  },
        );
        return {
            role: "user",
            content: content.every((part) => part.type === "text")
                ? content.map((part) => part.text).join("")
                : content,
            timestamp,
        };
    }
    if (message.role === "tool") {
        return {
            role: "toolResult",
            toolCallId: message.callId,
            providerToolCallId: message.callId,
            toolName: "",
            content: message.content.map((part) =>
                part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                          type: "image" as const,
                          data: part.data,
                          mimeType: part.mimeType,
                      },
            ),
            isError: message.isError === true,
            ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            sessionMessage: message,
            timestamp,
        };
    }
    const assistant: AssistantMessage = {
        role: "assistant",
        content: message.content.flatMap(sessionAssistantBlockToExecutionContent),
        api: "compaction",
        provider: "compaction",
        model: "compaction",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        sessionMessage: message,
        timestamp,
    };
    return assistant;
}

function sessionAssistantBlockToExecutionContent(block: SessionAssistantBlock): AssistantContent[] {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "reasoning") {
        return [
            {
                type: "thinking",
                thinking: block.text ?? "",
                ...(block.reasoning === undefined ? {} : { encrypted: block.reasoning }),
            },
        ];
    }
    if (block.type === "tool_result") return [];
    return [
        {
            type: "toolCall",
            id: block.callId,
            providerToolCallId: block.callId,
            name: block.name,
            ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
            arguments: parseCompactionToolArguments(block.arguments),
            ...(block.incomplete === undefined ? {} : { incomplete: block.incomplete }),
            ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
        },
    ];
}

function parseCompactionToolArguments(argumentsJson: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(argumentsJson) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { input: argumentsJson };
    } catch {
        return { input: argumentsJson };
    }
}

function latestTimestamp(messages: readonly Context["messages"][number][]): number {
    if (messages.length === 0) return Date.now();
    return messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
}
