import {
    AgentProviders,
    AgentSystemLocal,
    agentDatabase,
    currentAgentEnvironment,
    type Agent,
    type AgentBaseAcceptedMessage,
    type AgentBaseInferenceStart,
    type AgentBasePersistedEvent,
    type AgentConfig,
    type AgentDatabase,
    type AgentModel,
    type AgentModuleAgent,
    type AgentModule,
    type AgentModuleAgentLifecycle,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AgentStorage,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    SessionEvent,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type {
    PermissionReviewDecision,
    PermissionReviewRequest,
    PermissionReviewer,
} from "../permissions/PermissionReviewer.js";
import {
    createAutoPermissionTranscript,
    type AutoTranscriptMessage,
} from "./impl/createAutoPermissionTranscript.js";
import { createPermissionReviewInstructions } from "./impl/createPermissionReviewInstructions.js";
import { createPermissionReviewPrompt } from "./impl/createPermissionReviewPrompt.js";
import { readAutoSecurityPolicy } from "./impl/readAutoSecurityPolicy.js";
import { reviewerModelForAgent, type AutoReviewerRoute } from "./impl/reviewerModelForAgent.js";
import { buildAutoReviewCatalog } from "./impl/buildAutoReviewCatalog.js";
import { reviewerAgentId } from "./impl/reviewerAgentId.js";
import { convertGuardianReview } from "./impl/convertGuardianReview.js";
import { boundReviewTranscript } from "./impl/boundReviewTranscript.js";
import { AutoReviewEvidenceStore } from "./impl/AutoReviewEvidenceStore.js";
import { AutoReviewRuntimeModule } from "./impl/AutoReviewRuntimeModule.js";
import { AutoReviewComputeModule } from "./impl/AutoReviewComputeModule.js";
import {
    assistantTextEvidence,
    assistantToolCallEvidence,
    errorEvidence,
    toolResultEvidence,
    userMessageEvidence,
} from "./impl/evidenceEntries.js";
import { type AutoReviewerCursor, autoReviewerCursorSchema } from "./AutoReviewTranscript.js";

/**
 * The Auto-mode automatic permission reviewer, ported from Rig v1's guardian side agent into the v2
 * agent stack.
 *
 * `AutoModule` is two things wearing one name. As a main-system module it records the durable review
 * evidence — the exact, uncompacted, provenance-preserving transcript the reviewer judges — into its
 * own tables in the main database, observing the base hooks while message provenance and the
 * human-owned portion of an interactive answer still exist. As the owner of a completely separate
 * `AgentSystemLocal` it runs the reviews themselves: one private reviewer per main agent, on a
 * private database, lock, provider registry, model catalog, compute, and lifetime that nothing else
 * in the product can reach. Only `reviewer` leaves the module; the private system, its storage, the
 * reviewer IDs, and the catalog are unpublished, so guessing a reviewer ID addresses nothing.
 *
 * Two deliberate deviations from the specification, decided with the parent task:
 *
 * 1. Storage is injected, not opened here. `happy-agent-modules` opens no database anywhere, so
 *    rather than duplicate the host's SQLite and lock mechanics, `AutoModule` receives an
 *    already-constructed private `AgentStorage` — built by the host from a separate `auto-agent`
 *    database file and lock — and passes it to `AgentSystemLocal.create`. The isolation the
 *    specification requires (separate file, separate lock, separate schema, no shared state) is
 *    preserved; only the file-opening lives with the host that already owns that mechanism.
 * 2. The reviewer's read-only compute tools are injected. `AutoModule` owns no compute and imports
 *    no compute tool internals, so the host supplies a `reviewerTools` builder through the options;
 *    `AutoReviewComputeModule` calls it with the reviewer's own scope and presents the result
 *    unchanged. The vendor is chosen from the reviewer's own model route inside that builder — a
 *    Claude review gets Claude's read-only tools, a Codex review gets Codex's — exactly as Rig v1
 *    gave its review side agent its own provider's tools.
 *
 * The 90-second review budget is owned by `PermissionsModule`, which creates the abort controller
 * and the timer and derives timed-out/unavailable from a review that does not return. `AutoModule`
 * honors the request's abort signal, exports the exact v1 budget as `AUTO_PERMISSION_REVIEW_BUDGET_MS`
 * for the host to wire as that timeout, and never converts a cancellation into a verdict.
 */

/** The wall-clock budget for one review, exactly as Rig v1. The host wires this as the timeout. */
export const AUTO_PERMISSION_REVIEW_BUDGET_MS = 90_000;

const contextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const storageSchema = Type.Unsafe<AgentStorage>(Type.Object({}, { additionalProperties: true }));
const providersSchema = Type.Unsafe<AgentProviders>(
    Type.Object({}, { additionalProperties: true }),
);
const agentModelSchema = Type.Unsafe<AgentModel>(
    Type.Object(
        {
            providerId: Type.String({ minLength: 1 }),
            id: Type.String({ minLength: 1 }),
            name: Type.String(),
            effortLevels: Type.Array(Type.String()),
            defaultEffort: Type.String(),
        },
        { additionalProperties: true },
    ),
);
const reviewerToolsSchema = Type.Unsafe<(scope: AgentModuleScope) => readonly AnyAgentTool[]>(
    Type.Function([Type.Any()], Type.Any()),
);
const securityReaderSchema = Type.Unsafe<() => Promise<string | undefined>>(
    Type.Function([], Type.Any()),
);
const agentsMdReaderSchema = Type.Unsafe<
    (ctx: Context, agentId: string) => Promise<string | undefined>
>(Type.Function([Type.Any(), Type.Any()], Type.Any()));

/**
 * The runtime construction boundary for the module, kept TypeBox-first. The injected objects and
 * functions are described only enough to reject a plainly wrong shape; their real contracts are the
 * happy-agent-base types the `Static` derivation carries.
 */
export const autoModuleOptionsSchema = Type.Object(
    {
        /** The private review system's storage, opened by the host from a separate database/lock. */
        storage: storageSchema,
        /** The main provider registry, from which private, read-only resolving copies are made. */
        providers: providersSchema,
        /** The registry ID of the provider the private system creates reviewer agents with. */
        provider: Type.String({ minLength: 1, maxLength: 256 }),
        /** The main model catalog, copied and extended into the private reviewer catalog. */
        models: Type.Array(agentModelSchema, { minItems: 1 }),
        /** The absolute directory reviewer agents work under. */
        workingDirectory: Type.String({ minLength: 1, maxLength: 4_096 }),
        /** The application/agent-loader lifetime the private system and its lock belong to. */
        lifetimeContext: contextSchema,
        /** Builds the reviewer's fixed read-only tools for the reviewer's own vendor (deviation 2). */
        reviewerTools: reviewerToolsSchema,
        /** Reads and bounds the global `SECURITY.md`, or resolves undefined when absent. */
        readGlobalSecurity: securityReaderSchema,
        /** Reads and bounds the project-root `AGENTS_SECURITY.md`, or undefined when absent. */
        readProjectSecurity: securityReaderSchema,
        /**
         * Reads the formatted global/project `AGENTS.md` context for the reviewed agent, resolved
         * against that agent's own compute so the reviewer sees the project instructions in force
         * where the action was proposed. Resolves undefined when there is none.
         */
        readAgentsMd: Type.Optional(agentsMdReaderSchema),
    },
    { additionalProperties: false },
);

export type AutoModuleOptions = Static<typeof autoModuleOptionsSchema>;

/** A minimal validated shape for the only user-input event this module trusts as evidence. */
export const userInputAnsweredSchema = Type.Object(
    {
        type: Type.Literal("user_input_answered"),
        agentId: Type.String({ minLength: 1, maxLength: 128 }),
        requestId: Type.String({ minLength: 1, maxLength: 256 }),
        answer: Type.String({ maxLength: 65_536 }),
    },
    { additionalProperties: true },
);

export type UserInputAnsweredEvent = Static<typeof userInputAnsweredSchema>;

export class AutoModule implements AgentModule {
    readonly name = "auto";

    readonly #options: AutoModuleOptions;
    readonly #evidence = new AutoReviewEvidenceStore();
    readonly #runtime = new AutoReviewRuntimeModule();
    readonly #compute: AutoReviewComputeModule;

    /** The private review system, built in `beforeStart` and closed in `close`. */
    #system: AgentSystemLocal | undefined;
    /** The private catalog the reviewer resolves its model from. */
    #catalog: readonly AgentModel[] = [];
    /** Live private reviewer agents this process has built, keyed by the main agent they review. */
    readonly #reviewers = new Map<string, Agent>();
    /** Per-main-agent serialization tail: reviews for one agent are strictly FIFO. */
    readonly #tails = new Map<string, Promise<void>>();
    /** In-flight callId → tool name, so a tool result can be labelled as v1 did. */
    readonly #callTools = new Map<string, string>();
    /**
     * The last provider/model/effort each main agent ran an inference on. A permission review is
     * requested during a turn, so the route in force is the one the current turn's inference used;
     * we learn it from the agent-scoped hooks (which carry the live selection) and read it back
     * when a review needs the v1 model fallback. An agent we have never seen infer has no route,
     * and a review for it fails closed rather than guessing one.
     */
    readonly #activeRoutes = new Map<string, AutoReviewerRoute>();
    /** The shared idempotent shutdown. */
    #closePromise: Promise<void> | undefined;

    readonly migrations = this.#evidence.migrations;

    /** The only member handed to `PermissionsModule`. */
    readonly reviewer: PermissionReviewer = {
        review: (
            ctx: Context,
            request: PermissionReviewRequest,
        ): Promise<PermissionReviewDecision> => this.#review(ctx, request),
    };

    constructor(options: AutoModuleOptions) {
        if (!Value.Check(autoModuleOptionsSchema, options)) {
            throw new Error("Auto module options are invalid.");
        }
        this.#options = options;
        this.#compute = new AutoReviewComputeModule(options.reviewerTools);
    }

    // ---- Private review system lifecycle ------------------------------------------------------

    readonly beforeStart = async (
        _ctx: Context,
        _agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        const main = this.#options.providers;
        const privateProviders = new AgentProviders();
        for (const id of main.ids) {
            const type = main.typeOf(id);
            if (type === null) continue;
            // A private, read-only resolving copy. A resolution failure is an unavailable review,
            // never silent permission to use another provider.
            privateProviders.add(
                id,
                async ({ model }) => {
                    const resolved = await main.resolve(id, model);
                    if (resolved === null) {
                        throw new Error(`The reviewer provider "${id}" could not be resolved.`);
                    }
                    return resolved;
                },
                type,
            );
        }
        this.#catalog = buildAutoReviewCatalog({
            models: this.#options.models,
            typeOf: (id) => privateProviders.typeOf(id),
        });
        this.#system = await AgentSystemLocal.create(
            this.#options.lifetimeContext,
            this.#options.storage,
            {
                models: this.#catalog,
                modules: [this.#runtime, this.#compute],
                provider: this.#options.provider,
                providers: privateProviders,
            },
        );
        return this.#hooks;
    };

    readonly close = async (_ctx: Context): Promise<void> => {
        if (this.#closePromise === undefined) {
            this.#closePromise = (async () => {
                await this.#system?.close(this.#options.lifetimeContext);
            })();
        }
        await this.#closePromise;
    };

    // ---- Main-agent evidence hooks ------------------------------------------------------------

    readonly #hooks: AgentModuleHooks = {
        /** Learn the route the current turn runs on before every inference (v1 model fallback). */
        beforeInference: async (
            _ctx: Context,
            scope: AgentModuleScope,
            _inference: AgentBaseInferenceStart,
        ): Promise<void> => {
            this.#rememberRoute(scope.agent);
        },

        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            this.#rememberRoute(scope.agent);
            // Only a user-role message can carry authorization at all. A queued system notice
            // or an agent payload is runtime-generated, so it contributes no evidence rather
            // than evidence the reviewer might read as something the person said.
            if (accepted.message.role !== "user") return;
            const entry = userMessageEvidence(accepted.message, accepted.metadata as never);
            if (entry === undefined) return;
            await this.#appendEvidence(ctx, scope.agent.id, () => entry);
        },

        onEventTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            this.#rememberRoute(scope.agent);
            if (event.type === "text_end") {
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    assistantTextEvidence(event.block.text),
                );
            } else if (event.type === "toolcall_end") {
                // The label is the tool's full identity, namespace included, because that is what
                // the model called and what the reviewer must recognize in the transcript. Two
                // servers may expose the same bare name, and "search" says nothing about which.
                const name = qualifiedToolName(event.block);
                this.#callTools.set(callKey(scope.agent.id, event.block.callId), name);
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    assistantToolCallEvidence(name, event.block.arguments),
                );
            }
        },

        afterToolCallTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            result: SessionToolResultMessage,
        ): Promise<void> => {
            const database = this.#databaseOf(ctx);
            const answer = await this.#evidence.consumeUserAnswer(
                database,
                scope.agent.id,
                result.callId,
            );
            const toolName = this.#callTools.get(callKey(scope.agent.id, result.callId)) ?? "tool";
            this.#callTools.delete(callKey(scope.agent.id, result.callId));
            await this.#appendEvidence(ctx, scope.agent.id, () =>
                toolResultEvidence({
                    toolName,
                    content: result.content,
                    isError: result.isError === true,
                    ...(answer === undefined
                        ? {}
                        : { trustedUserAnswer: trustedAnswerText(answer) }),
                }),
            );
        },

        /** Provider retry and terminal error responses are untrusted context, exactly as v1. */
        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: SessionEvent,
        ): Promise<void> => {
            if (event.type === "retrying") {
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    errorEvidence(event.reason, true),
                );
            } else if (event.type === "done" && event.state === "error") {
                await this.#appendEvidence(ctx, scope.agent.id, () =>
                    errorEvidence(event.message, false),
                );
            }
        },

        /** A compaction erased the conversation the evidence described; start a new generation. */
        historyErasedTransact: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
            await this.#startGeneration(ctx, scope.agent.id);
        },

        /** A (re)created identity may reuse an ID; clear any stale evidence under it atomically. */
        agentCreatedTransact: async (
            ctx: Context,
            _scope: AgentModuleSystemScope,
            agent: AgentModuleAgentLifecycle,
        ): Promise<void> => {
            await this.#startGeneration(ctx, agent.id);
            // The remembered route belongs to the agent that used to hold this ID. A new identity
            // has not inferred yet, so its review must fail closed on an unknown route rather than
            // pick the previous occupant's model. A compaction does not do this: the agent running
            // the turn is the same one, and its route is still the live one.
            this.#activeRoutes.delete(agent.id);
        },
    };

    /**
     * Begin a fresh evidence generation for one agent and forget everything the previous one left
     * behind in memory. The pending call labels go with it: a recreated identity may reuse both an
     * agent ID and a call ID, and a result labelled from the erased conversation would name a tool
     * this conversation never called.
     */
    async #startGeneration(ctx: Context, agentId: string): Promise<void> {
        await this.#evidence.bumpGeneration(this.#databaseOf(ctx), agentId);
        const prefix = callKey(agentId, "");
        for (const key of this.#callTools.keys()) {
            if (key.startsWith(prefix)) this.#callTools.delete(key);
        }
    }

    /**
     * Record the human-owned answer to one interactive request as trusted evidence, keyed by the
     * request ID the tool result will carry. Only this path marks anything trusted; a model-authored
     * question and all other tool output remain untrusted.
     */
    async recordUserInputEventTransactional(ctx: Context, event: unknown): Promise<void> {
        if (!Value.Check(userInputAnsweredSchema, event)) {
            throw new Error("Only a validated user_input_answered event may be recorded.");
        }
        const answer: AutoTranscriptMessage = {
            role: "user",
            blocks: [{ type: "text", text: event.answer }],
        };
        await this.#evidence.recordUserAnswer(
            this.#databaseOf(ctx),
            event.agentId,
            event.requestId,
            answer,
        );
    }

    // ---- Review ------------------------------------------------------------------------------

    async #review(
        ctx: Context,
        request: PermissionReviewRequest,
    ): Promise<PermissionReviewDecision> {
        if (request.signal.aborted) throw new Error("Permission review was stopped.");
        return await this.#serialize(request.agentId, () => this.#runReview(ctx, request));
    }

    async #runReview(
        ctx: Context,
        request: PermissionReviewRequest,
    ): Promise<PermissionReviewDecision> {
        // Reviews for one agent are strictly FIFO, so this one may have waited behind another while
        // its turn was stopped. The signal is read again here, after the queue releases it, because
        // a review whose turn is already gone must never reach the reviewer.
        if (request.signal.aborted) throw new Error("Permission review was stopped.");
        const system = this.#requireSystem();
        const mainAgentId = request.agentId;
        const mainDatabase = this.#databaseOf(ctx);

        const state = await this.#evidence.readState(mainDatabase, mainAgentId);
        if (!state.archiveHealthy) {
            throw new Error("The automatic permission review evidence archive is unhealthy.");
        }
        const generation = state.generation;
        const entries = await this.#evidence.readEntries(mainDatabase, mainAgentId, generation);

        const reviewerId = reviewerAgentId(mainAgentId);
        const route = reviewerModelForAgent({
            models: this.#catalog,
            active: this.#activeRoute(request),
        });

        const cursor = await this.#readCursor(reviewerId);
        const rebuild =
            cursor === undefined ||
            cursor.evidenceGeneration !== generation ||
            !cursor.lastReviewNormal;
        let activeCursor: AutoReviewerCursor;
        if (rebuild) {
            await this.#recreateReviewer(system, mainAgentId, reviewerId);
            activeCursor = {
                evidenceGeneration: generation,
                reviewedPosition: 0,
                reportedOwnEntryCount: 0,
                lastReviewNormal: true,
            };
        } else {
            await this.#ensureReviewer(system, mainAgentId, reviewerId);
            if (cursor === undefined) {
                throw new Error("Unreachable: a non-rebuild review must have a stored cursor.");
            }
            activeCursor = cursor;
        }
        // "First" is a fact about the reviewer's own session, not about how far the cursor reached.
        // A rebuilt reviewer has no history to continue; a reused one does even when the archive was
        // empty both times, and sending it a fresh `<conversation>` would deny it the context it is
        // still holding.
        const first = rebuild;

        const whole = createAutoPermissionTranscript(entries);
        const delta = first
            ? whole
            : createAutoPermissionTranscript(entries.slice(activeCursor.reviewedPosition));

        const instructions = await this.#buildInstructions(ctx, mainAgentId);
        this.#runtime.beginReview(reviewerId, instructions);

        const prompt = createPermissionReviewPrompt({
            first,
            conversation: delta.text,
            action: proposedAction(request),
        });
        const message: SessionUserMessage = {
            role: "user",
            content: [{ type: "text", text: prompt }],
        };

        const reviewerAgent = this.#reviewers.get(mainAgentId);
        const onAbort = (): void => {
            void system.abort(this.#options.lifetimeContext, reviewerId).catch(() => undefined);
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
            await system.send(this.#options.lifetimeContext, reviewerId, message, {
                await: true,
                permissionMode: "read_only",
                provider: route.providerId,
                model: route.modelId,
                effort: route.effort,
            });
            await reviewerAgent?.waitForIdle();
        } catch (error: unknown) {
            await this.#discardReviewer(system, mainAgentId, reviewerId, generation);
            if (request.signal.aborted) throw new Error("Permission review was stopped.");
            throw error;
        } finally {
            request.signal.removeEventListener("abort", onAbort);
        }

        const capture = this.#runtime.takeCapture(reviewerId);
        const transcript = boundReviewTranscript({
            entries: capture.entries,
            usage: capture.usage,
            inferred: capture.inferred,
            modelId: route.modelId,
            providerId: route.providerId,
        });

        if (request.signal.aborted) throw new Error("Permission review was stopped.");
        if (capture.doneState !== "normal") {
            // A completed-but-not-normal run is a v1 rejection with an unreadable answer; the
            // reviewer is discarded so the next review starts over from the whole transcript.
            await this.#discardReviewer(system, mainAgentId, reviewerId, generation);
            return convertGuardianReview({
                text: "",
                ...(transcript === undefined ? {} : { transcript }),
                userEvidenceOmitted: whole.userEvidenceOmitted,
            });
        }

        await this.#writeCursor(reviewerId, {
            evidenceGeneration: generation,
            reviewedPosition: entries.length,
            reportedOwnEntryCount: capture.entries.length,
            lastReviewNormal: true,
        });
        return convertGuardianReview({
            text: finalReviewerText(capture.entries),
            ...(transcript === undefined ? {} : { transcript }),
            userEvidenceOmitted: whole.userEvidenceOmitted,
        });
    }

    // ---- Reviewer lifecycle -------------------------------------------------------------------

    async #ensureReviewer(
        system: AgentSystemLocal,
        mainAgentId: string,
        reviewerId: string,
    ): Promise<void> {
        if (this.#reviewers.has(mainAgentId)) return;
        const existing = await system.config(this.#options.lifetimeContext, reviewerId);
        const agent =
            existing === undefined
                ? await system.create(this.#options.lifetimeContext, this.#reviewerConfig(), {
                      id: reviewerId,
                  })
                : await system.resolve(this.#options.lifetimeContext, reviewerId);
        this.#reviewers.set(mainAgentId, agent);
    }

    async #recreateReviewer(
        system: AgentSystemLocal,
        mainAgentId: string,
        reviewerId: string,
    ): Promise<void> {
        this.#reviewers.delete(mainAgentId);
        const existing = await system.config(this.#options.lifetimeContext, reviewerId);
        if (existing !== undefined) {
            await system.delete(this.#options.lifetimeContext, reviewerId);
        }
        const agent = await system.create(this.#options.lifetimeContext, this.#reviewerConfig(), {
            id: reviewerId,
        });
        this.#reviewers.set(mainAgentId, agent);
    }

    async #discardReviewer(
        system: AgentSystemLocal,
        mainAgentId: string,
        reviewerId: string,
        generation: number,
    ): Promise<void> {
        // Mark the cursor so the next review rebuilds and resends the whole transcript, matching
        // v1 discardUnfinishedReview. The reviewer is deleted now; the next review recreates it.
        this.#reviewers.delete(mainAgentId);
        await this.#writeCursor(reviewerId, {
            evidenceGeneration: generation,
            reviewedPosition: 0,
            reportedOwnEntryCount: 0,
            lastReviewNormal: false,
        });
        const existing = await system
            .config(this.#options.lifetimeContext, reviewerId)
            .catch(() => undefined);
        if (existing !== undefined) {
            await system.delete(this.#options.lifetimeContext, reviewerId).catch(() => undefined);
        }
    }

    #reviewerConfig(): AgentConfig {
        return {
            environment: {
                ...currentAgentEnvironment(),
                workingDirectory: this.#options.workingDirectory,
            },
            modules: { autoReviewCompute: {}, autoReviewRuntime: {} },
            metadata: { title: "Automatic permission reviewer" },
        };
    }

    // ---- Helpers ------------------------------------------------------------------------------

    async #buildInstructions(ctx: Context, mainAgentId: string): Promise<string> {
        const securityPolicy = await readAutoSecurityPolicy({
            readGlobalSecurity: this.#options.readGlobalSecurity,
            readProjectSecurity: this.#options.readProjectSecurity,
        });
        const guardian = createPermissionReviewInstructions(securityPolicy);
        const projectContext =
            this.#options.readAgentsMd === undefined
                ? undefined
                : await this.#options.readAgentsMd(ctx, mainAgentId);
        return projectContext === undefined || projectContext.trim().length === 0
            ? guardian
            : `${guardian}\n\n${projectContext.trim()}`;
    }

    /** Record the live provider/model/effort of a main agent, when it has one selected. */
    #rememberRoute(agent: AgentModuleAgent): void {
        if (agent.model === undefined || agent.effort === undefined) return;
        this.#activeRoutes.set(agent.id, {
            providerId: agent.provider,
            modelId: agent.model,
            effort: agent.effort,
        });
    }

    /**
     * The main agent's current provider/model/effort route, learned from the agent-scoped hooks.
     * A review is only requested while a turn is running, so the route has already been observed;
     * if it somehow has not, this throws and the caller derives an unavailable review rather than
     * reviewing on an arbitrary model.
     */
    #activeRoute(request: PermissionReviewRequest): AutoReviewerRoute {
        const route = this.#activeRoutes.get(request.agentId);
        if (route === undefined) {
            throw new Error(
                `No active model route is known for agent "${request.agentId}"; the reviewer ` +
                    "cannot select a model.",
            );
        }
        return route;
    }

    async #appendEvidence(
        ctx: Context,
        agentId: string,
        build: () => {
            category: "message" | "tool";
            entry: AutoTranscriptMessage;
            trustedUserEvidence: boolean;
            trustedUserEvidenceTruncated: boolean;
        },
    ): Promise<void> {
        const database = this.#databaseOf(ctx);
        try {
            await this.#evidence.appendEntry(database, agentId, build());
        } catch {
            // A failed archive write must not roll back the conversation; the archive is marked
            // unhealthy instead, and the next review fails closed rather than approving from it.
            await this.#evidence.markUnhealthy(database, agentId).catch(() => undefined);
        }
    }

    #databaseOf(ctx: Context): AgentDatabase {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("The auto module hook ran without an active database.");
        }
        return database;
    }

    #requireSystem(): AgentSystemLocal {
        if (this.#system === undefined) {
            throw new Error("The automatic permission review system is not running.");
        }
        return this.#system;
    }

    #serialize<Result>(agentId: string, operation: () => Promise<Result>): Promise<Result> {
        const previous = this.#tails.get(agentId) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        this.#tails.set(
            agentId,
            result.then(
                () => undefined,
                () => undefined,
            ),
        );
        return result;
    }

    async #readCursor(reviewerId: string): Promise<AutoReviewerCursor | undefined> {
        const kv = this.#options.storage.kv.scoped("autoCursor");
        const stored = await kv.read(this.#privateDbContext(), reviewerId);
        if (stored === undefined) return undefined;
        if (!Value.Check(autoReviewerCursorSchema, stored)) {
            throw new Error(`The stored reviewer cursor for "${reviewerId}" is invalid.`);
        }
        return stored;
    }

    async #writeCursor(reviewerId: string, cursor: AutoReviewerCursor): Promise<void> {
        const kv = this.#options.storage.kv.scoped("autoCursor");
        await kv.write(this.#privateDbContext(), reviewerId, cursor);
    }

    #privateDbContext(): Context {
        return this.#options.lifetimeContext;
    }
}

/** The proposed action, serialized exactly as v1: `{description, tool, arguments}`. */
function proposedAction(request: PermissionReviewRequest): string {
    try {
        return (
            JSON.stringify({
                description: request.action,
                tool: qualifiedToolName(request.tool),
                arguments: request.arguments,
            }) ?? String(request.action)
        );
    } catch {
        return String(request.action);
    }
}

function qualifiedToolName(tool: { readonly name: string; readonly namespace?: string }): string {
    return tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
}

/** The reviewer's verdict is the trailing text of its last message, joined as v1 joined it. */
function finalReviewerText(
    entries: readonly { readonly type: string; readonly text?: string }[],
): string {
    const trailing: string[] = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type !== "text") break;
        trailing.push(entry.text ?? "");
    }
    return trailing.reverse().join("\n");
}

/** The text blocks of a stored user answer, for attaching as trusted evidence to a tool result. */
function trustedAnswerText(
    answer: AutoTranscriptMessage,
): { readonly type: "text"; readonly text: string }[] {
    return answer.blocks.flatMap((block) =>
        block.type === "text" ? [{ type: "text" as const, text: block.text }] : [],
    );
}

function callKey(agentId: string, callId: string): string {
    return `${agentId}\u0000${callId}`;
}
