import { createHash } from "node:crypto";

import type {
    CreateSessionRequest,
    ModelCatalog,
    ProtocolSession,
    SessionEvent,
    SubagentSummary,
} from "../protocol/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import { isLiveOnlySessionEvent } from "../protocol/projection/isLiveOnlySessionEvent.js";
import type { ConversationRepository } from "../conversations/ConversationRepository.js";
import { HappyMachineClient } from "./HappyMachineClient.js";
import {
    HappySessionClient,
    type HappyProjectContext,
    type HappySessionClientOptions,
} from "./HappySessionClient.js";
import { HappySyncOutboxFullError, HappySyncRepository } from "./HappySyncRepository.js";
import { HappyMessageMapper } from "./mapSessionEventToHappyMessages.js";
import { handleHappySpawnSession } from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration, HappySessionProtocolMessage } from "./types.js";
import type { Context } from "@steve.kite/stdlib";
import { withWorkerContext } from "../observability/index.js";
import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import type { RigAgentService } from "../agent/RigAgentService.js";
import type { AgentContext } from "../agent/index.js";

const MAX_BACKFILLED_MESSAGES = 10_000;
const MAX_MAPPED_EVENTS = 4_096;
const MAX_RECOVERY_EVENTS_PER_PASS = 256;
const ATTACH_RETRY_DELAY_MS = 5_000;

export interface HappySyncServiceOptions {
    agents?: RigAgentService;
    configuration: HappyConnectionConfiguration;
    createSession?: (
        ctx: Context,
        id: string,
        request: CreateSessionRequest,
    ) => void | Promise<void>;
    conversations: ConversationRepository;
    database: SessionDatabase;
    fetch?: typeof fetch;
    getSubagents?: (
        ctx: Context,
        sessionId: string,
    ) => readonly SubagentSummary[] | Promise<readonly SubagentSummary[]>;
    getProjectContext?: (
        ctx: Context,
        conversationId: string,
    ) => HappyProjectContext | Promise<HappyProjectContext>;
    modelCatalog?: ModelCatalog;
    maxPendingMessagesPerSession?: number;
    socketFactory?: HappySessionClientOptions["socketFactory"];
    resolveExternalControlContext?: (
        ctx: Context,
        conversationId: string,
    ) => AgentContext | Promise<AgentContext>;
}

export class HappySyncService {
    readonly #attaches = new Map<string, Promise<void>>();
    readonly #agents: RigAgentService | undefined;
    readonly #attachRetryAfter = new Map<string, number>();
    readonly #backfillTimers = new Map<string, NodeJS.Timeout>();
    readonly #clients = new Map<string, HappySessionClient>();
    readonly #detachedClientClosures = new Map<string, Promise<void>>();
    readonly #messageMappers = new Map<string, HappyMessageMapper>();
    readonly #pendingReattachments = new Set<string>();
    #closed = false;
    readonly #configuration: HappyConnectionConfiguration;
    readonly #conversations: ConversationRepository;
    readonly #credentialFingerprint: string;
    readonly #createSession: HappySyncServiceOptions["createSession"];
    readonly #fetch: typeof fetch | undefined;
    readonly #getSubagents: NonNullable<HappySyncServiceOptions["getSubagents"]>;
    readonly #getProjectContext: HappySyncServiceOptions["getProjectContext"];
    readonly #modelCatalog: ModelCatalog | undefined;
    readonly #machineClient: HappyMachineClient | undefined;
    readonly #repository: HappySyncRepository;
    readonly #socketFactory: HappySessionClientOptions["socketFactory"];
    readonly #resolveExternalControlContext:
        | HappySyncServiceOptions["resolveExternalControlContext"]
        | undefined;

    private constructor(options: HappySyncServiceOptions, repository: HappySyncRepository) {
        this.#agents = options.agents;
        this.#configuration = options.configuration;
        this.#conversations = options.conversations;
        this.#credentialFingerprint = fingerprint(options.configuration);
        this.#createSession = options.createSession;
        this.#fetch = options.fetch;
        this.#getSubagents = options.getSubagents ?? (() => []);
        this.#getProjectContext = options.getProjectContext;
        this.#modelCatalog = options.modelCatalog;
        this.#repository = repository;
        this.#socketFactory = options.socketFactory;
        this.#resolveExternalControlContext = options.resolveExternalControlContext;
        if (
            options.configuration.machineId !== undefined &&
            options.createSession !== undefined &&
            options.modelCatalog !== undefined
        ) {
            try {
                this.#machineClient = new HappyMachineClient({
                    configuration: options.configuration,
                    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                    modelCatalog: options.modelCatalog,
                    ...(options.socketFactory === undefined
                        ? {}
                        : { socketFactory: options.socketFactory }),
                    spawnSession: (params, signal) =>
                        withWorkerContext("happy-machine-spawn-session", (ctx) =>
                            handleHappySpawnSession({
                                createSession: async (id, request) => {
                                    await this.#createSession!(ctx, id, request);
                                    await this.attach(ctx, id);
                                },
                                machineId: options.configuration.machineId!,
                                modelCatalog: options.modelCatalog!,
                                params,
                                signal,
                                waitForRemoteSession: (sessionId) =>
                                    this.#clients.get(sessionId)?.waitForRemoteSession(ctx) ??
                                    Promise.resolve(undefined),
                            }),
                        ),
                });
            } catch (error) {
                this.#machineClient = undefined;
                console.error(`Happy machine sync is unavailable: ${String(error)}`);
            }
        } else {
            this.#machineClient = undefined;
        }
    }

    static async open(ctx: Context, options: HappySyncServiceOptions): Promise<HappySyncService> {
        const repository = HappySyncRepository.using(
            options.database,
            Date.now,
            options.maxPendingMessagesPerSession,
        );
        void ctx;
        return new HappySyncService(options, repository);
    }

    async attach(ctx: Context, conversationId: string): Promise<void> {
        if (this.#clients.has(conversationId)) return;
        const snapshot = await this.#conversations.readSnapshot(ctx, conversationId);
        if (snapshot === undefined) return;
        const closure = this.#detachedClientClosures.get(conversationId);
        if (closure !== undefined && !snapshot.archived) {
            this.#scheduleReattach(conversationId, closure);
            return;
        }
        await this.#attachOnce(ctx, conversationId, false, snapshot);
    }

    /** Lets the access hot path avoid creating a worker for an already synchronized session. */
    shouldAttachOnAccess(conversationId: string): boolean {
        if (
            this.#closed ||
            this.#clients.has(conversationId) ||
            this.#attaches.has(conversationId)
        ) {
            return false;
        }
        if (this.#pendingReattachments.has(conversationId)) return false;
        return (this.#attachRetryAfter.get(conversationId) ?? 0) <= Date.now();
    }

    async #attachOnce(
        ctx: Context,
        conversationId: string,
        includeArchived: boolean,
        knownSnapshot?: ProtocolSession,
    ): Promise<void> {
        const existing = this.#attaches.get(conversationId);
        if (existing !== undefined) return await existing;
        const attachment = this.#attachSession(ctx, conversationId, includeArchived, knownSnapshot);
        this.#attaches.set(conversationId, attachment);
        try {
            await attachment;
        } finally {
            if (this.#attaches.get(conversationId) === attachment) {
                this.#attaches.delete(conversationId);
            }
        }
    }

    async #attachSession(
        ctx: Context,
        conversationId: string,
        includeArchived: boolean,
        knownSnapshot?: ProtocolSession,
    ): Promise<void> {
        if (this.#closed || this.#clients.has(conversationId)) return;
        const snapshot =
            knownSnapshot ?? (await this.#conversations.readSnapshot(ctx, conversationId));
        if (snapshot === undefined) return;
        if (snapshot.agent.type !== "primary" || (snapshot.archived && !includeArchived)) {
            return;
        }
        let client = this.#clients.get(conversationId);
        if (client === undefined) {
            if ((this.#attachRetryAfter.get(conversationId) ?? 0) > Date.now()) return;
            try {
                const encryption = this.#configuration.credentials.encryption;
                const state = await this.#repository.ensureSession(ctx, {
                    credentialFingerprint: this.#credentialFingerprint,
                    ...(encryption.type === "legacy" ? { encryptionKey: encryption.secret } : {}),
                    encryptionVariant: encryption.type,
                    sessionId: conversationId,
                });
                if (this.#closed) return;
                client = new HappySessionClient({
                    ...(this.#agents === undefined ? {} : { agents: this.#agents }),
                    configuration: this.#configuration,
                    conversations: this.#conversations,
                    ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
                    getSubagents: (ctx, sessionId) => this.#getSubagents(ctx, sessionId),
                    ...(this.#getProjectContext === undefined
                        ? {}
                        : {
                              projectContext: (ctx) =>
                                  this.#getProjectContext?.(ctx, conversationId),
                          }),
                    ...(this.#modelCatalog === undefined
                        ? {}
                        : { modelCatalog: this.#modelCatalog }),
                    repository: this.#repository,
                    ...(this.#resolveExternalControlContext === undefined
                        ? {}
                        : { resolveExternalControlContext: this.#resolveExternalControlContext }),
                    sessionId: conversationId,
                    ...(this.#socketFactory === undefined
                        ? {}
                        : { socketFactory: this.#socketFactory }),
                });
                this.#clients.set(conversationId, client);
                if (!includeArchived) {
                    const events = await this.#conversations.events(ctx, conversationId);
                    const backfill = mapSessionEvents(
                        events,
                        state.historyBackfilled ? state.projectedEventId : undefined,
                    );
                    this.#messageMappers.set(conversationId, backfill.mapper);
                    if (!state.historyBackfilled) {
                        await this.#repository.enqueueInitialBackfill(
                            ctx,
                            conversationId,
                            backfill.messages,
                            latestDurableEventId(events),
                        );
                    } else if (backfill.cursorFound) {
                        await this.#enqueueRecovered(
                            ctx,
                            conversationId,
                            client,
                            backfill.projections,
                        );
                    } else if (state.projectedEventId !== latestDurableEventId(events)) {
                        const reason = `Happy projection cursor '${state.projectedEventId ?? "none"}' is outside the bounded session event window.`;
                        await this.#repository.stallProjectionGap(ctx, conversationId, reason);
                        console.error(
                            `Happy sync cannot recover session '${conversationId}': ${reason}`,
                        );
                    }
                }
                if (!this.#closed) client.start(ctx);
                this.#attachRetryAfter.delete(conversationId);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                this.#clients.delete(conversationId);
                this.#messageMappers.delete(conversationId);
                this.#attachRetryAfter.set(conversationId, Date.now() + ATTACH_RETRY_DELAY_MS);
                await client?.close(ctx).catch(rethrowDatabaseFailure);
                console.error(
                    `Happy sync could not attach session '${conversationId}': ${String(error)}`,
                );
            }
        }
    }

    async close(ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#machineClient?.close();
        for (const timer of this.#backfillTimers.values()) clearTimeout(timer);
        this.#backfillTimers.clear();
        this.#attachRetryAfter.clear();
        const attachmentResults = await Promise.allSettled(this.#attaches.values());
        this.#attaches.clear();
        const clientResults = await Promise.allSettled([
            ...[...this.#clients.values()].map((client) => client.close(ctx)),
            ...this.#detachedClientClosures.values(),
        ]);
        this.#clients.clear();
        this.#detachedClientClosures.clear();
        this.#messageMappers.clear();
        this.#pendingReattachments.clear();
        await this.#repository.close(ctx);
        const results = [...attachmentResults, ...clientResults];
        const failure =
            results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected" && isDatabaseFailure(result.reason),
            ) ??
            results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure !== undefined) throw failure.reason;
    }

    async observe(ctx: Context, event: SessionEvent): Promise<void> {
        if (this.#closed) return;
        const conversationId = event.sessionId;
        const snapshot = await this.#conversations.readSnapshot(ctx, conversationId);
        if (snapshot === undefined || snapshot.agent.type !== "primary") return;
        if (isLiveOnlySessionEvent(event)) return;
        if (snapshot.archived) {
            if (
                !this.#detachedClientClosures.has(conversationId) &&
                (await this.#repository.getSession(ctx, conversationId)) !== undefined
            ) {
                await this.#attachOnce(ctx, conversationId, true, snapshot);
            }
            this.#detach(conversationId);
            return;
        }
        const closure = this.#detachedClientClosures.get(conversationId);
        if (closure !== undefined) {
            this.#scheduleReattach(conversationId, closure);
            return;
        }
        try {
            await this.attach(ctx, conversationId);
            if (event.type === "session_archived" && event.data.archived === false) {
                this.#clients.get(conversationId)?.resume(ctx);
            }
            const mapper = this.#messageMappers.get(conversationId) ?? new HappyMessageMapper();
            this.#messageMappers.set(conversationId, mapper);
            const client = this.#clients.get(conversationId);
            if (client === undefined) return;
            const result = await this.#repository.enqueueProjection(
                ctx,
                conversationId,
                event.id,
                mapper.map(event),
            );
            if (result.status === "stalled") {
                throw new HappySyncOutboxFullError(
                    result.reason,
                    result.cause !== "event_too_large",
                );
            }
            client.kick(ctx);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            const client = this.#clients.get(conversationId);
            if (error instanceof HappySyncOutboxFullError) {
                if (error.recoverable) this.#scheduleBackfill(conversationId);
            } else if (client !== undefined && this.#clients.get(conversationId) === client) {
                this.#clients.delete(conversationId);
                this.#messageMappers.delete(conversationId);
                this.#attachRetryAfter.set(conversationId, Date.now() + ATTACH_RETRY_DELAY_MS);
                await client.close(ctx).catch(rethrowDatabaseFailure);
            }
            console.error(
                `Happy sync could not observe session '${conversationId}': ${String(error)}`,
            );
        }
    }

    async start(ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#machineClient?.start();
        void ctx;
    }

    #detach(sessionId: string): void {
        const timer = this.#backfillTimers.get(sessionId);
        if (timer !== undefined) clearTimeout(timer);
        this.#backfillTimers.delete(sessionId);
        this.#attachRetryAfter.delete(sessionId);
        this.#messageMappers.delete(sessionId);
        const client = this.#clients.get(sessionId);
        if (client === undefined) return;
        this.#clients.delete(sessionId);
        const closure = withWorkerContext("happy-session-archive", (ctx) => client.archive(ctx));
        this.#detachedClientClosures.set(sessionId, closure);
        void closure.then(
            async () => {
                if (this.#detachedClientClosures.get(sessionId) === closure) {
                    this.#detachedClientClosures.delete(sessionId);
                }
            },
            (error: unknown) => {
                if (this.#detachedClientClosures.get(sessionId) === closure) {
                    this.#detachedClientClosures.delete(sessionId);
                }
                rethrowDatabaseFailure(error);
            },
        );
    }

    #scheduleReattach(conversationId: string, closure: Promise<void>): void {
        if (this.#pendingReattachments.has(conversationId)) return;
        this.#pendingReattachments.add(conversationId);
        void closure.then(
            () =>
                withWorkerContext("happy-session-reattach", async (ctx) => {
                    this.#pendingReattachments.delete(conversationId);
                    const snapshot = await this.#conversations.readSnapshot(ctx, conversationId);
                    if (this.#closed || snapshot === undefined || snapshot.archived) return;
                    try {
                        await this.attach(ctx, conversationId);
                        this.#clients.get(conversationId)?.resume(ctx);
                    } catch (error) {
                        if (isDatabaseFailure(error)) throw error;
                        console.error(
                            `Happy sync could not restore session '${conversationId}': ${String(error)}`,
                        );
                    }
                }),
            (error: unknown) => {
                this.#pendingReattachments.delete(conversationId);
                rethrowDatabaseFailure(error);
            },
        );
    }

    #scheduleBackfill(conversationId: string): void {
        if (this.#backfillTimers.has(conversationId)) return;
        const timer = setTimeout(() => {
            this.#backfillTimers.delete(conversationId);
            void withWorkerContext("happy-session-backfill", (ctx) =>
                this.#runBackfill(ctx, conversationId),
            ).catch(rethrowDatabaseFailure);
        }, ATTACH_RETRY_DELAY_MS);
        timer.unref();
        this.#backfillTimers.set(conversationId, timer);
    }

    async #runBackfill(ctx: Context, conversationId: string): Promise<void> {
        const client = this.#clients.get(conversationId);
        if (client === undefined) {
            await this.attach(ctx, conversationId);
            return;
        }
        try {
            const state = await this.#repository.getSession(ctx, conversationId);
            if (state === undefined) return;
            const events = await this.#conversations.events(ctx, conversationId);
            const backfill = mapSessionEvents(events, state.projectedEventId);
            if (!backfill.cursorFound && state.projectedEventId !== latestDurableEventId(events)) {
                const reason = "Happy projection recovery fell outside the bounded event window.";
                await this.#repository.stallProjectionGap(ctx, conversationId, reason);
                console.error(`Happy sync cannot recover session '${conversationId}': ${reason}`);
                return;
            }
            this.#messageMappers.set(conversationId, backfill.mapper);
            await this.#enqueueRecovered(ctx, conversationId, client, backfill.projections);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (!(error instanceof HappySyncOutboxFullError) || error.recoverable) {
                this.#scheduleBackfill(conversationId);
            }
            console.error(
                `Happy sync could not recover session '${conversationId}': ${String(error)}`,
            );
        }
    }

    async #enqueueRecovered(
        ctx: Context,
        conversationId: string,
        client: HappySessionClient,
        projections: readonly HappyEventProjection[],
    ): Promise<void> {
        const bounded = projections.slice(0, MAX_RECOVERY_EVENTS_PER_PASS);
        for (const projection of bounded) {
            const result = await this.#repository.enqueueProjection(
                ctx,
                conversationId,
                projection.event.id,
                projection.messages,
            );
            if (result.status === "stalled") {
                throw new HappySyncOutboxFullError(
                    result.reason,
                    result.cause !== "event_too_large",
                );
            }
        }
        client.kick(ctx);
        if (projections.length > bounded.length) this.#scheduleBackfill(conversationId);
    }
}

interface HappyEventProjection {
    event: SessionEvent;
    messages: ReturnType<HappyMessageMapper["map"]>;
}

function latestDurableEventId(events: readonly SessionEvent[]): string | undefined {
    return events.at(-1)?.id;
}

function mapSessionEvents(
    allEvents: readonly SessionEvent[],
    afterEventId?: string,
): {
    cursorFound: boolean;
    mapper: HappyMessageMapper;
    messages: ReturnType<HappyMessageMapper["map"]>;
    projections: readonly HappyEventProjection[];
} {
    const mapper = new HappyMessageMapper();
    const events = allEvents.slice(-MAX_MAPPED_EVENTS);
    let cursorFound = afterEventId === undefined;
    const projections: HappyEventProjection[] = [];
    const mapped: HappySessionProtocolMessage[] = [];
    for (const event of events) {
        const messages = mapper.map(event);
        if (cursorFound) {
            projections.push({ event, messages });
            mapped.push(...messages);
        }
        if (event.id === afterEventId) cursorFound = true;
    }
    if (mapped.length <= MAX_BACKFILLED_MESSAGES) {
        return { cursorFound, mapper, messages: mapped, projections };
    }
    const cutoff = mapped.length - MAX_BACKFILLED_MESSAGES;
    let start = cutoff;
    for (let index = cutoff; index >= 0; index -= 1) {
        if (mapped[index]?.content.ev.t !== "turn-start") continue;
        start = index;
        break;
    }
    return {
        cursorFound,
        mapper,
        messages: mapped.slice(start),
        projections,
    };
}

function fingerprint(configuration: HappyConnectionConfiguration): string {
    const encryption = configuration.credentials.encryption;
    const key = encryption.type === "legacy" ? encryption.secret : encryption.publicKey;
    return createHash("sha256")
        .update(configuration.serverUrl)
        .update(encryption.type)
        .update(key)
        .digest("hex");
}
