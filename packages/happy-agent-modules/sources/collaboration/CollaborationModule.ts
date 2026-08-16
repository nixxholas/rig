import {
    agentConfigSchema,
    agentPermissionMode,
    type AgentModule,
    type AgentModuleScope,
    type AgentMetadataChange,
    type AnyAgentTool,
    type AgentPermissionMode,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    COLLABORATION_MAX_TIMESTAMP,
    COLLABORATION_METADATA_MAX_DEPTH,
    COLLABORATION_METADATA_MAX_ENCODED_BYTES,
    collaborationAgentIdSchema,
    collaborationAgentObservationSchema,
    collaborationAgentPageQuerySchema,
    collaborationAgentSchema,
    collaborationAgentSelectionSchema,
    collaborationCreateInputSchema,
    collaborationModelCatalogSchema,
    collaborationMetadataSchema,
    type CollaborationAgent,
    type CollaborationAgentObservation,
    type CollaborationAgentPage,
    type CollaborationAgentPageQuery,
    type CollaborationCreateInput,
    type CollaborationModelCatalog,
    type CollaborationMetadata,
    type CollaborationSpawnCapacity,
} from "./CollaborationAgent.js";
import {
    collaborationEventIdSchema,
    collaborationEventSchema,
    collaborationModuleListenerSchema,
    type CollaborationEvent,
    type CollaborationModuleListener,
} from "./CollaborationEvent.js";
import {
    collaborationMessageIdSchema,
    collaborationMessageSchema,
    collaborationObligationPageQuerySchema,
    collaborationObligationSchema,
    collaborationReplyInputSchema,
    collaborationSendInputSchema,
    collaborationSendResultSchema,
    collaborationWaitForAgentInputSchema,
    collaborationWaitInputSchema,
    collaborationWaitResultSchema,
    type CollaborationMessage,
    type CollaborationObligation,
    type CollaborationObligationPage,
    type CollaborationObligationPageQuery,
    type CollaborationReplyInput,
    type CollaborationSendInput,
    type CollaborationSendResult,
    type CollaborationWaitInput,
    type CollaborationWaitForAgentInput,
    type CollaborationWaitResult,
} from "./CollaborationMessage.js";
import {
    assertCollaborationAgentPage,
    assertCollaborationAgentObservation,
    assertCollaborationBrokerAgentResult,
    assertCollaborationObligationPage,
    assertCollaborationSpawnCapacity,
    assertCollaborationVoidResult,
    collaborationAuthorizationSchema,
    collaborationBrokerSchema,
    collaborationBrokerSendOptionsSchema,
    collaborationContextSchema,
    type CollaborationAuthorization,
    type CollaborationBroker,
    type CollaborationRoster,
    type CollaborationStore,
} from "./CollaborationStore.js";
import { createAgentTool } from "./tools/create_agent.js";
import { interruptAgentTool } from "./tools/interrupt_agent.js";
import { listAgentsTool } from "./tools/list_agents.js";
import { replyToMessageTool } from "./tools/reply_to_message.js";
import { sendMessageTool } from "./tools/send_message.js";
import { waitForReplyTool } from "./tools/wait_for_reply.js";
import {
    collaborationMigrations,
    createSqliteCollaborationStorage,
} from "./SqliteCollaborationStorage.js";

const asyncVoidResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
const idFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationAgentIdSchema, Type.Promise(collaborationAgentIdSchema)]),
);
const messageIdFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationMessageIdSchema, Type.Promise(collaborationMessageIdSchema)]),
);
const eventFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationEventIdSchema, Type.Promise(collaborationEventIdSchema)]),
);

const collaborationModuleOptionsSchema = Type.Object(
    {
        broker: collaborationBrokerSchema,
        modelCatalog: Type.Optional(collaborationModelCatalogSchema),
        authorization: Type.Optional(collaborationAuthorizationSchema),
        idFactory: Type.Optional(idFactorySchema),
        messageIdFactory: Type.Optional(messageIdFactorySchema),
        eventIdFactory: Type.Optional(eventFactorySchema),
        clock: Type.Optional(
            Type.Function([], Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP })),
        ),
        listener: Type.Optional(collaborationModuleListenerSchema),
        onPostCommitError: Type.Optional(
            Type.Function(
                [collaborationContextSchema, collaborationEventSchema, Type.Unknown()],
                asyncVoidResultSchema,
            ),
        ),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        maxOutputCharacters: Type.Optional(Type.Integer({ minimum: 256, maximum: 50_000 })),
    },
    { additionalProperties: false },
);

export { collaborationModuleOptionsSchema };
export type CollaborationModuleOptions = Static<typeof collaborationModuleOptionsSchema>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 8_000;
/**
 * Collaboration is a database-backed module, not an agent manager. Its roster, messages,
 * and obligations are installed by this module's migrations; only Agent Base delivery and
 * waiting remain external.
 */
export class CollaborationModule implements AgentModule {
    readonly name = "collaboration";
    readonly migrations = collaborationMigrations;

    readonly #roster: CollaborationRoster;
    readonly #store: CollaborationStore;
    readonly #broker: CollaborationBroker;
    readonly #modelCatalog: CollaborationModelCatalog | undefined;
    readonly #authorization: CollaborationAuthorization | undefined;
    readonly #listener: CollaborationModuleListener | undefined;
    readonly #idFactory: NonNullable<CollaborationModuleOptions["idFactory"]>;
    readonly #messageIdFactory: NonNullable<CollaborationModuleOptions["messageIdFactory"]>;
    readonly #eventIdFactory: NonNullable<CollaborationModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<CollaborationModuleOptions["clock"]>;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: CollaborationModuleOptions["onPostCommitError"];

    constructor(options: CollaborationModuleOptions) {
        const validated = validateOptions(options);
        const storage = createSqliteCollaborationStorage();
        this.#roster = storage.roster;
        this.#store = storage.store;
        this.#broker = validated.broker;
        this.#modelCatalog =
            validated.modelCatalog === undefined
                ? undefined
                : structuredClone(validated.modelCatalog);
        if (this.#modelCatalog !== undefined) assertModelCatalog(this.#modelCatalog);
        this.#authorization = validated.authorization;
        this.#listener = validated.listener;
        this.#idFactory = validated.idFactory ?? ((_ctx, _acting) => generatedId("a"));
        this.#messageIdFactory =
            validated.messageIdFactory ?? ((_ctx, _acting) => generatedId("m"));
        this.#eventIdFactory = validated.eventIdFactory ?? ((_ctx, _acting) => generatedId("e"));
        this.#clock = validated.clock ?? (() => Date.now());
        this.#maxPageSize = validated.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = validated.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#onPostCommitError = validated.onPostCommitError;
        this.#assertValue(
            Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
            this.#clock(),
            "clock value",
        );
    }

    /**
     * Create a collaborator and its Agent Base identity atomically. The acting agent owns the
     * resulting roster row; a missing actor is accepted only for a self-owned bootstrap root.
     */
    async createAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationCreateInput,
    ): Promise<CollaborationAgent> {
        this.#assertAgentId(actingAgentId, "acting agent");
        if (input !== null && typeof input === "object") {
            const rawInput = input as { readonly metadata?: unknown; readonly config?: unknown };
            if (rawInput.metadata !== undefined) assertBoundedMetadata(rawInput.metadata);
            if (isRecord(rawInput.config) && rawInput.config.metadata !== undefined) {
                assertBoundedMetadata(rawInput.config.metadata);
            }
        }
        this.#assertInput(collaborationCreateInputSchema, input, "create agent");
        const permissionMode = agentPermissionMode(ctx);
        const selection = this.#validateSelection({
            model: input.model,
            effort: input.effort,
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
        });
        const readOnly = normalizeReadOnly(permissionMode, input.readOnly);
        const fork = normalizeFork(input.context, input.forkTurns);
        const id =
            input.id ??
            (await this.#generatedId(
                ctx,
                actingAgentId,
                this.#idFactory,
                collaborationAgentIdSchema,
                "agent",
            ));

        const planned = await ctx.inTx(async (txCtx) => {
            const actor = await this.#readAgent(txCtx, actingAgentId);
            const parentId =
                input.parentId === undefined
                    ? actor === undefined
                        ? null
                        : actingAgentId
                    : input.parentId;
            if (actor === undefined) {
                if (id !== actingAgentId || parentId !== null) {
                    throw new Error(
                        "A missing acting agent may create only its own root collaborator.",
                    );
                }
            } else if (parentId === null) {
                throw new Error("An existing agent may create only an owned child.");
            } else {
                const parent = await this.#readRequiredAgent(txCtx, parentId);
                await this.#authorize(txCtx, actingAgentId, parent, "create");
            }

            const metadata = mergedMetadata(input.config.metadata, input.metadata);
            const config = {
                ...input.config,
                ...(metadata === undefined ? {} : { metadata }),
            };
            this.#assertValue(agentConfigSchema, config, "Agent Base configuration");
            const expectedConfig = structuredClone(config);

            const existing = await this.#readAgent(txCtx, id);
            if (existing !== undefined) {
                throw new Error(`Collaborator "${id}" already exists.`);
            }

            const at = this.#now();
            const roster: CollaborationAgent = {
                id,
                ownerAgentId: actingAgentId,
                parentId,
                ...(input.role === undefined ? {} : { role: input.role }),
                ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(metadata === undefined ? {} : { metadata }),
                status: "idle",
                runVersion: 0,
                createdAt: at,
                updatedAt: at,
            };
            this.#assertAgent(roster);
            return {
                config: expectedConfig,
                context: fork.context,
                ...(fork.forkTurns === undefined ? {} : { forkTurns: fork.forkTurns }),
                permissionMode,
                readOnly,
                roster,
                selection,
            };
        });

        const brokerConfig = await this.#broker.config(ctx, id);
        if (brokerConfig === undefined) {
            await this.#assertCanSpawn(
                ctx,
                planned.roster.parentId === null ? actingAgentId : planned.roster.parentId,
            );
            const createdRaw: unknown = this.#broker.create(ctx, structuredClone(planned.config), {
                id,
                parent: planned.roster.parentId,
                selection: structuredClone(planned.selection),
                context: planned.context,
                permissionMode: planned.permissionMode,
                ...(planned.forkTurns === undefined ? {} : { forkTurns: planned.forkTurns }),
                ...(planned.readOnly === undefined ? {} : { readOnly: planned.readOnly }),
            });
            const created = await requirePromise(createdRaw, "Collaboration broker create");
            assertCollaborationBrokerAgentResult(created);
            if (created.id !== id) {
                throw new Error("Agent Base did not preserve the requested collaborator ID.");
            }
        }
        await this.#assertBrokerConfig(ctx, id, planned.config);
        await this.#assertBrokerSelection(ctx, id, planned.selection);

        return await ctx.inTx(async (txCtx) => {
            const existing = await this.#readAgent(txCtx, id);
            if (existing !== undefined) {
                if (!sameValue(existing, planned.roster)) {
                    throw new Error("Collaborator retry disagrees with durable roster state.");
                }
                return existing;
            }
            const roster = planned.roster;
            await this.#writeAgent(txCtx, roster);
            const persisted = await this.#readRequiredAgent(txCtx, id);
            if (!sameValue(persisted, roster)) {
                throw new Error("Collaboration roster substituted the created agent.");
            }
            const event = await this.#event(txCtx, {
                type: "agent_created",
                actingAgentId,
                agent: roster,
            });
            await this.#announce(txCtx, event);
            return structuredClone(roster);
        });
    }

    async getAgent(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<CollaborationAgent | undefined> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertAgentId(targetAgentId, "target agent");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const target = await this.#readAgent(ctx, targetAgentId);
        if (target === undefined) return undefined;
        await this.#validateAgentReferences(ctx, target);
        await this.#authorize(ctx, actingAgentId, target, "read");
        return structuredClone(target);
    }

    async listAgents(
        ctx: Context,
        actingAgentId: string,
        query: CollaborationAgentPageQuery = {},
    ): Promise<CollaborationAgentPage> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertInput(collaborationAgentPageQuerySchema, query, "agent page query");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const normalized = {
            limit: query.limit ?? this.#maxPageSize,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.groupId === undefined ? {} : { groupId: query.groupId }),
            ...(query.ownerAgentId === undefined ? {} : { ownerAgentId: query.ownerAgentId }),
        };
        this.#assertPageLimit(normalized.limit, "agent");
        let requestedLimit = normalized.limit;
        for (let attempt = 0; attempt <= normalized.limit; attempt += 1) {
            const pageRaw: unknown = this.#roster.listAgents(ctx, actingAgentId, {
                ...normalized,
                limit: requestedLimit,
            });
            const page = await requirePromise(pageRaw, "Collaboration roster listAgents");
            assertCollaborationAgentPage(page);
            this.#assertReturnedPage(page.limit, page.agents.length, requestedLimit, "agents");
            this.#assertCursorProgress(page.nextCursor, query.cursor, page.agents.length, "agents");
            this.#assertAgentPageInvariants(page);
            for (const agent of page.agents) {
                await this.#validateAgentReferences(ctx, agent);
                await this.#authorize(ctx, actingAgentId, agent, "list");
            }
            const fitting = this.#fittingAgentCount(page);
            if (fitting === page.agents.length) {
                this.formatAgentPageForModel(page);
                return structuredClone(page);
            }
            if (fitting < 1) {
                throw new Error(
                    "Collaboration roster output budget cannot fit one complete agent identity and cursor.",
                );
            }
            requestedLimit = fitting;
        }
        throw new Error("Collaboration roster could not make output-aware page progress.");
    }

    async sendMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationSendInput,
    ): Promise<CollaborationSendResult> {
        this.#assertAgentId(actingAgentId, "acting agent");
        if (input !== null && typeof input === "object" && "metadata" in input) {
            assertBoundedMetadata(input.metadata);
        }
        this.#assertInput(collaborationSendInputSchema, input, "send message");
        if ("replyTo" in input) {
            throw new Error("Use replyMessage for a directed reply.");
        }
        return await this.#send(ctx, actingAgentId, input, "send");
    }

    async replyMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationReplyInput,
    ): Promise<CollaborationSendResult> {
        this.#assertAgentId(actingAgentId, "acting agent");
        if (input !== null && typeof input === "object" && "metadata" in input) {
            assertBoundedMetadata(input.metadata);
        }
        this.#assertInput(collaborationReplyInputSchema, input, "reply message");
        return await this.#send(ctx, actingAgentId, input, "reply");
    }

    /** Alias kept descriptive for host callers. */
    async reply(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationReplyInput,
    ): Promise<CollaborationSendResult> {
        return await this.replyMessage(ctx, actingAgentId, input);
    }

    /**
     * Interrupt a collaborator's current turn while keeping its durable identity and queued
     * follow-up work. The host broker owns the actual Agent Base cancellation.
     */
    async interruptAgent(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<CollaborationAgentObservation> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertAgentId(targetAgentId, "target agent");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const target = await this.#readRequiredAgent(ctx, targetAgentId);
        await this.#authorize(ctx, actingAgentId, target, "interrupt");

        const before = await this.#observeAgent(ctx, actingAgentId, targetAgentId);
        await this.#reconcileObservation(ctx, actingAgentId, before);
        if (!isInterruptibleStatus(before.status)) {
            throw new Error(`Collaborator "${targetAgentId}" is not running.`);
        }
        const interruptedRaw: unknown = this.#broker.interrupt(ctx, actingAgentId, targetAgentId);
        const interrupted = await requirePromise(interruptedRaw, "Collaboration broker interrupt");
        assertCollaborationAgentObservation(interrupted);
        if (interrupted.agentId !== targetAgentId) {
            throw new Error("Collaboration broker interrupted a different agent.");
        }
        if (!isTerminalInterruptStatus(interrupted.status)) {
            throw new Error("Collaboration broker did not stop the collaborator's current turn.");
        }
        if (interrupted.version <= before.version) {
            throw new Error("Collaboration broker returned a stale interruption result.");
        }
        await this.#reconcileObservation(ctx, actingAgentId, interrupted);
        return structuredClone(interrupted);
    }

    async listObligations(
        ctx: Context,
        actingAgentId: string,
        query: CollaborationObligationPageQuery = {},
    ): Promise<CollaborationObligationPage> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertInput(collaborationObligationPageQuerySchema, query, "obligation page query");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const normalized = {
            limit: query.limit ?? this.#maxPageSize,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.requesterAgentId === undefined
                ? {}
                : { requesterAgentId: query.requesterAgentId }),
            ...(query.responderAgentId === undefined
                ? {}
                : { responderAgentId: query.responderAgentId }),
        };
        this.#assertPageLimit(normalized.limit, "obligation");
        const pageRaw: unknown = this.#store.listObligations(ctx, actingAgentId, normalized);
        const page = await requirePromise(pageRaw, "Collaboration store listObligations");
        assertCollaborationObligationPage(page);
        this.#assertReturnedPage(
            page.limit,
            page.obligations.length,
            normalized.limit,
            "obligations",
        );
        this.#assertCursorProgress(
            page.nextCursor,
            query.cursor,
            page.obligations.length,
            "obligations",
        );
        const seenObligations = new Set<string>();
        for (const obligation of page.obligations) {
            this.#assertObligation(obligation);
            const persisted = await this.#readRequiredObligation(ctx, obligation.id);
            if (!sameValue(persisted, obligation)) {
                throw new Error("Collaboration store substituted an obligation page entry.");
            }
            if (seenObligations.has(obligation.id)) {
                throw new Error("Collaboration store returned duplicate obligations.");
            }
            seenObligations.add(obligation.id);
            if (
                obligation.requesterAgentId !== actingAgentId &&
                obligation.responderAgentId !== actingAgentId
            ) {
                throw new Error(
                    "Collaboration store returned an obligation outside the acting agent.",
                );
            }
        }
        return structuredClone(page);
    }

    async waitForReply(
        ctx: Context,
        actingAgentId: string,
        inputOrWait: CollaborationWaitInput | CollaborationWaitForAgentInput | string,
    ): Promise<CollaborationWaitResult> {
        this.#assertAgentId(actingAgentId, "acting agent");
        const input = typeof inputOrWait === "string" ? { obligationId: inputOrWait } : inputOrWait;

        if (isRecord(input) && "agentId" in input) {
            this.#assertInput(collaborationWaitForAgentInputSchema, input, "agent wait");
            return await this.#waitForAgent(ctx, actingAgentId, input);
        }

        this.#assertInput(collaborationWaitInputSchema, input, "wait");

        await ctx.inTx(async (txCtx) => {
            await this.#readRequiredAgent(txCtx, actingAgentId);
            const obligation = await this.#readRequiredObligation(txCtx, input.obligationId);
            if (obligation.requesterAgentId !== actingAgentId) {
                throw new Error("An agent may wait only for its own reply obligations.");
            }
        });

        const waitedRaw: unknown = this.#broker.wait(ctx, actingAgentId, input.obligationId);
        const waited = await requirePromise(waitedRaw, "Collaboration broker wait");
        this.#assertObligation(waited);
        if (
            waited.id !== input.obligationId ||
            waited.requesterAgentId !== actingAgentId ||
            waited.status === "pending"
        ) {
            throw new Error("Collaboration broker returned an invalid wait result.");
        }

        return await ctx.inTx(async (txCtx) => {
            await this.#readRequiredAgent(txCtx, actingAgentId);
            const current = await this.#readRequiredObligation(txCtx, input.obligationId);
            if (current.requesterAgentId !== actingAgentId) {
                throw new Error("An agent may wait only for its own reply obligations.");
            }
            if (current.status === "pending") {
                throw new Error(
                    "Collaboration broker wait completed without persisting the obligation.",
                );
            }
            if (!sameValue(current, waited)) {
                throw new Error("Collaboration wait result disagrees with the host obligation.");
            }
            const result = structuredClone(current);
            this.#assertValue(collaborationWaitResultSchema, result, "wait result");
            return result;
        });
    }

    async wait(
        ctx: Context,
        actingAgentId: string,
        inputOrWait: CollaborationWaitInput | CollaborationWaitForAgentInput | string,
    ): Promise<CollaborationWaitResult> {
        return await this.waitForReply(ctx, actingAgentId, inputOrWait);
    }

    readonly tools = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<readonly AnyAgentTool[]> => {
        const capacity = await this.#spawnCapacity(ctx, scope.agent.id);
        const tools: AnyAgentTool[] = [
            createAgentTool(this, scope.agent.id, {
                capacity,
            }),
            listAgentsTool(this, scope.agent.id, this.#maxOutputCharacters),
            sendMessageTool(this, scope.agent.id),
            replyToMessageTool(this, scope.agent.id),
            waitForReplyTool(this, scope.agent.id),
            interruptAgentTool(this, scope.agent.id),
        ];
        return tools;
    };

    readonly metadataChangedTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        change: AgentMetadataChange,
    ): Promise<void> => {
        this.#assertAgentId(scope.agent.id, "metadata agent");
        this.#assertMetadata(change.metadata);
        const current = await this.#readRequiredAgent(ctx, scope.agent.id);
        const updated: CollaborationAgent = {
            ...current,
            ...(change.metadata.title === undefined ? {} : { title: change.metadata.title }),
            metadata: change.metadata,
            updatedAt: this.#now(),
        };
        this.#assertAgent(updated);
        await this.#writeAgent(ctx, updated);
        const persisted = await this.#readRequiredAgent(ctx, scope.agent.id);
        if (!sameValue(persisted, updated)) {
            throw new Error("Collaboration roster substituted metadata.");
        }
    };

    readonly beforeAgentLoopTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<void> => {
        await this.#ensureLoopAgent(ctx, scope.agent.id);
        await this.#setStatus(ctx, scope.agent.id, "active");
    };

    readonly afterAgentSettledTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<void> => {
        await this.#setStatus(ctx, scope.agent.id, "idle");
    };

    /** Render the injected model catalog and current capacity for the create tool description. */
    describeCreateAgentCapability(capacity: CollaborationSpawnCapacity): string {
        this.#assertSpawnCapacity(capacity);
        const models =
            this.#modelCatalog?.availableModels.map(
                (model) =>
                    `- ${model.providerId} + ${model.id} (${model.name}; effort: ${model.effortLevels.join(", ")}${
                        model.serviceTiers === undefined
                            ? ""
                            : `; tiers: ${model.serviceTiers.join(", ")}`
                    })`,
            ) ?? [];
        const disabled =
            this.#modelCatalog?.disabledProviders.map(
                (provider) => `- ${provider.id} (${provider.reason.replaceAll("_", " ")})`,
            ) ?? [];
        const active =
            capacity.maxActive === undefined
                ? ""
                : ` Active collaborators: ${capacity.active ?? 0}/${capacity.maxActive}.`;
        const depth = ` Spawn depth: ${capacity.depth}/${capacity.maxDepth}.`;
        const availability = capacity.canSpawn
            ? "Spawning is currently available."
            : "Spawning is currently unavailable; do not call create_agent.";
        const text = [
            "Choose an exact model and effort when creating a collaborator. Provider is optional when the model ID is unambiguous.",
            availability + depth + active,
            ...(this.#modelCatalog === undefined
                ? [
                      "Model catalog unavailable; the host will validate the requested model and effort.",
                  ]
                : ["Available model/provider pairs:", ...models]),
            ...(disabled.length === 0 ? [] : ["Disabled providers:", ...disabled]),
            "Use context `task` for a fresh task prompt, or `parent` to fork parent context. `forkTurns` may be `none`, `all`, or a positive integer string.",
            "Set readOnly true to force Read only, or false to restore the sender's current permission mode.",
        ].join("\n");
        return truncateForModel(
            text,
            this.#maxOutputCharacters,
            "[collaboration creation guidance truncated]",
        );
    }

    /** Bound the complete model-facing create description, including the tool's fixed preface. */
    formatCreateAgentDescription(preface: string, capacity: CollaborationSpawnCapacity): string {
        return truncateForModel(
            `${preface}\n\n${this.describeCreateAgentCapability(capacity)}`,
            this.#maxOutputCharacters,
            "[collaboration creation guidance truncated]",
        );
    }

    /** Render a bounded collaborator observation for model-facing tool output. */
    formatAgentObservationForModel(observation: CollaborationAgentObservation): string {
        this.#assertValue(collaborationAgentObservationSchema, observation, "agent observation");
        const prefix = `Collaborator ${observation.agentId}${
            observation.path === undefined ? "" : ` (${observation.path})`
        } is ${observation.status}.`;
        if (observation.output === undefined) {
            return truncateForModel(
                prefix,
                this.#maxOutputCharacters,
                "[agent observation truncated]",
            );
        }
        const marker = " [output truncated]";
        const outputLabel = "\nOutput: ";
        const available =
            this.#maxOutputCharacters - prefix.length - outputLabel.length - marker.length;
        if (available > 0) {
            const output =
                observation.output.length > available
                    ? `${observation.output.slice(0, available)}${marker}`
                    : observation.output;
            return `${prefix}${outputLabel}${output}`;
        }
        return truncateForModel(
            `${prefix}${outputLabel}${observation.output}`,
            this.#maxOutputCharacters,
            "[agent observation truncated]",
        );
    }

    async #send(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationSendInput | CollaborationReplyInput,
        kind: "send" | "reply",
    ): Promise<CollaborationSendResult> {
        const recipientId = input.toAgentId;
        const permissionMode = agentPermissionMode(ctx);
        const readOnly = normalizeReadOnly(permissionMode, input.readOnly);
        const messageId =
            input.messageId ??
            (await this.#generatedId(
                ctx,
                actingAgentId,
                this.#messageIdFactory,
                collaborationMessageIdSchema,
                "message",
            ));
        const planned = await ctx.inTx(async (txCtx) => {
            await this.#readRequiredAgent(txCtx, actingAgentId);
            const recipient = await this.#readRequiredAgent(txCtx, recipientId);
            await this.#authorize(txCtx, actingAgentId, recipient, kind);
            if (input.readOnly !== undefined) {
                await this.#authorize(txCtx, actingAgentId, recipient, "permission");
            }

            const replyTo = "replyTo" in input ? input.replyTo : undefined;
            let existingObligation: CollaborationObligation | undefined;
            if (replyTo !== undefined) {
                existingObligation = await this.#readRequiredObligation(txCtx, replyTo);
                if (existingObligation.responderAgentId !== actingAgentId) {
                    throw new Error("Only the requested responder may answer this obligation.");
                }
                if (existingObligation.requesterAgentId !== recipientId) {
                    throw new Error("A reply must be sent to the requesting agent.");
                }
                if (existingObligation.status !== "pending") {
                    throw new Error("The reply obligation is no longer pending.");
                }
            }
            const obligationId =
                replyTo !== undefined || !("expectReply" in input) || input.expectReply !== true
                    ? undefined
                    : messageId;
            const at = this.#now();
            const messageMetadata = collaborationMessageMetadata(
                input.metadata,
                messageId,
                actingAgentId,
                recipientId,
                obligationId,
                replyTo,
            );
            const message: CollaborationMessage = {
                id: messageId,
                fromAgentId: actingAgentId,
                toAgentId: recipientId,
                text: input.text,
                ...(replyTo === undefined ? {} : { replyTo }),
                ...(obligationId === undefined ? {} : { obligationId }),
                metadata: messageMetadata,
                createdAt: at,
            };
            this.#assertMessage(message);
            const existing = await this.#readMessage(txCtx, messageId);
            if (existing !== undefined) {
                throw new Error(`Message "${messageId}" already exists.`);
            }
            const brokerOptions = {
                id: messageId,
                metadata: messageMetadata,
            };
            this.#assertValue(
                collaborationBrokerSendOptionsSchema,
                brokerOptions,
                "broker send options",
            );
            return {
                brokerOptions,
                existingObligation,
                message,
                obligationId,
                replyTo,
                permissionMode,
                readOnly,
            };
        });

        if (planned.readOnly !== undefined) {
            const permissionRaw: unknown = this.#broker.setReadOnly(
                ctx,
                actingAgentId,
                recipientId,
                planned.readOnly,
                planned.permissionMode,
            );
            assertCollaborationVoidResult(
                await requirePromise(permissionRaw, "Collaboration broker permission switch"),
                "broker permission switch",
            );
        }

        const sendRaw: unknown = this.#broker.send(
            ctx,
            recipientId,
            {
                role: "user",
                content: [{ type: "text", text: input.text }],
            },
            planned.brokerOptions,
        );
        assertCollaborationVoidResult(
            await requirePromise(sendRaw, "Collaboration broker send"),
            "broker send",
        );

        return await ctx.inTx(async (txCtx) => {
            const message = planned.message;
            const at = message.createdAt;
            const existingMessage = await this.#readMessage(txCtx, messageId);
            if (existingMessage !== undefined) {
                if (!sameValue(existingMessage, message)) {
                    throw new Error("Message retry disagrees with durable state.");
                }
                const obligation =
                    planned.obligationId === undefined
                        ? planned.replyTo === undefined
                            ? undefined
                            : await this.#readRequiredObligation(txCtx, planned.replyTo)
                        : await this.#readRequiredObligation(txCtx, planned.obligationId);
                const existingResult = {
                    message: existingMessage,
                    ...(obligation === undefined ? {} : { obligation }),
                };
                this.#assertSendResult(existingResult);
                return structuredClone(existingResult);
            }
            await this.#writeMessage(txCtx, message);
            const persistedMessage = await this.#readRequiredMessage(txCtx, messageId);
            if (!sameValue(persistedMessage, message)) {
                throw new Error("Collaboration store substituted the sent message.");
            }

            let obligation: CollaborationObligation | undefined;
            if (planned.obligationId !== undefined) {
                obligation = {
                    id: planned.obligationId,
                    requesterAgentId: actingAgentId,
                    responderAgentId: recipientId,
                    messageId,
                    status: "pending",
                    createdAt: at,
                    updatedAt: at,
                };
                this.#assertObligation(obligation);
                await this.#writeObligation(txCtx, obligation);
                obligation = await this.#readRequiredObligation(txCtx, planned.obligationId);
                if (
                    !sameValue(obligation, {
                        id: planned.obligationId,
                        requesterAgentId: actingAgentId,
                        responderAgentId: recipientId,
                        messageId,
                        status: "pending",
                        createdAt: at,
                        updatedAt: at,
                    })
                ) {
                    throw new Error("Collaboration store substituted the reply obligation.");
                }
            } else if (planned.existingObligation !== undefined) {
                const existingObligation = await this.#readRequiredObligation(
                    txCtx,
                    planned.existingObligation.id,
                );
                if (existingObligation.status !== "pending") {
                    throw new Error("The reply obligation is no longer pending.");
                }
                const answered: CollaborationObligation = {
                    ...existingObligation,
                    status: "answered",
                    answerMessageId: messageId,
                    updatedAt: at,
                };
                this.#assertObligation(answered);
                await this.#writeObligation(txCtx, answered);
                obligation = await this.#readRequiredObligation(txCtx, answered.id);
                if (!sameValue(obligation, answered)) {
                    throw new Error("Collaboration store substituted the answered obligation.");
                }
            }
            const result = {
                message: persistedMessage,
                ...(obligation === undefined ? {} : { obligation }),
            };
            this.#assertSendResult(result);
            const event = await this.#event(txCtx, {
                type: "message_sent",
                actingAgentId,
                message: persistedMessage,
                ...(obligation === undefined ? {} : { obligation }),
            });
            await this.#announce(txCtx, event);
            if (planned.existingObligation !== undefined && obligation !== undefined) {
                const answerEvent = await this.#event(txCtx, {
                    type: "reply_answered",
                    actingAgentId,
                    obligationId: obligation.id,
                    answerMessageId: messageId,
                });
                await this.#announce(txCtx, answerEvent);
            }
            return structuredClone(result);
        });
    }

    async #waitForAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationWaitForAgentInput,
    ): Promise<CollaborationAgentObservation> {
        this.#assertAgentId(input.agentId, "target agent");
        await ctx.inTx(async (txCtx) => {
            await this.#readRequiredAgent(txCtx, actingAgentId);
            const target = await this.#readRequiredAgent(txCtx, input.agentId);
            await this.#authorize(txCtx, actingAgentId, target, "wait");
        });

        const waitedRaw: unknown = this.#broker.waitForAgent(
            ctx,
            actingAgentId,
            input.agentId,
            input.timeoutMs ?? 3_600_000,
        );
        const waited = await requirePromise(waitedRaw, "Collaboration broker agent wait");
        assertCollaborationAgentObservation(waited);
        if (waited.agentId !== input.agentId) {
            throw new Error("Collaboration broker waited for a different agent.");
        }
        await this.#reconcileObservation(ctx, actingAgentId, waited);
        return structuredClone(waited);
    }

    async #observeAgent(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<CollaborationAgentObservation> {
        const observedRaw: unknown = this.#broker.observe(ctx, actingAgentId, targetAgentId);
        const observed = await requirePromise(observedRaw, "Collaboration broker observe");
        assertCollaborationAgentObservation(observed);
        if (observed.agentId !== targetAgentId) {
            throw new Error("Collaboration broker observed a different agent.");
        }
        return structuredClone(observed);
    }

    async #spawnCapacity(ctx: Context, actingAgentId: string): Promise<CollaborationSpawnCapacity> {
        const raw: unknown = this.#broker.spawnCapacity(ctx, actingAgentId);
        const capacity = await requirePromise(raw, "Collaboration broker spawn capacity");
        this.#assertSpawnCapacity(capacity);
        return structuredClone(capacity);
    }

    async #assertCanSpawn(ctx: Context, actingAgentId: string): Promise<void> {
        const capacity = await this.#spawnCapacity(ctx, actingAgentId);
        if (!capacity.canSpawn) {
            if (capacity.depth >= capacity.maxDepth) {
                throw new Error("This agent has reached the maximum subagent depth.");
            }
            if (
                capacity.maxActive !== undefined &&
                capacity.active !== undefined &&
                capacity.active >= capacity.maxActive
            ) {
                throw new Error("The maximum number of active collaborators has been reached.");
            }
            throw new Error("This agent cannot create a collaborator right now.");
        }
    }

    #assertSpawnCapacity(value: unknown): asserts value is CollaborationSpawnCapacity {
        assertCollaborationSpawnCapacity(value);
        if (value.depth > value.maxDepth) {
            throw new Error("Collaboration broker returned an invalid spawn depth.");
        }
        if (
            value.maxActive !== undefined &&
            value.active !== undefined &&
            value.active > value.maxActive
        ) {
            throw new Error("Collaboration broker returned invalid active capacity.");
        }
        if (value.canSpawn === true && value.depth >= value.maxDepth) {
            throw new Error("Collaboration broker returned inconsistent spawn capacity.");
        }
        if (
            value.canSpawn === true &&
            value.maxActive !== undefined &&
            value.active !== undefined &&
            value.active >= value.maxActive
        ) {
            throw new Error("Collaboration broker returned inconsistent active capacity.");
        }
    }

    #validateSelection(input: {
        readonly model: string;
        readonly effort: CollaborationCreateInput["effort"];
        readonly provider?: string;
        readonly serviceTier?: CollaborationCreateInput["serviceTier"];
    }): Static<typeof collaborationAgentSelectionSchema> {
        const selection = {
            model: input.model,
            effort: input.effort,
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
        };
        this.#assertValue(collaborationAgentSelectionSchema, selection, "agent selection");
        if (this.#modelCatalog === undefined) return structuredClone(selection);
        const catalog = this.#modelCatalog;
        if (
            input.provider !== undefined &&
            catalog.disabledProviders.some(({ id }) => id === input.provider)
        ) {
            throw new Error(`Provider "${input.provider}" is disabled for collaborators.`);
        }
        if (input.provider === undefined) {
            const providers = new Set(
                catalog.availableModels
                    .filter((model) => model.id === input.model)
                    .map(({ providerId }) => providerId),
            );
            if (providers.size > 1) {
                throw new Error(
                    `Provider is required because model "${input.model}" is available from multiple providers.`,
                );
            }
        }
        const disabledProviders = new Set(catalog.disabledProviders.map(({ id }) => id));
        const candidates = catalog.availableModels.filter(
            (model) =>
                model.id === input.model &&
                (input.provider === undefined || model.providerId === input.provider) &&
                !disabledProviders.has(model.providerId),
        );
        if (candidates.length === 0) {
            throw new Error(
                input.provider === undefined
                    ? `Model "${input.model}" is not available for collaborators.`
                    : `Model "${input.model}" is not available for provider "${input.provider}".`,
            );
        }
        const effortCandidates = candidates.filter((model) =>
            model.effortLevels.includes(input.effort),
        );
        if (effortCandidates.length === 0) {
            throw new Error(
                `Effort "${input.effort}" is not available for collaborator model "${input.model}".`,
            );
        }
        const candidate = effortCandidates.find(
            (model) =>
                input.serviceTier === undefined ||
                model.serviceTiers?.includes(input.serviceTier) === true,
        );
        if (input.serviceTier !== undefined && candidate === undefined) {
            throw new Error(
                `Service tier "${input.serviceTier}" is not available for collaborator model "${input.model}".`,
            );
        }
        return structuredClone(selection);
    }

    async #reconcileObservation(
        ctx: Context,
        actingAgentId: string,
        observation: CollaborationAgentObservation,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await this.#readRequiredAgent(txCtx, actingAgentId);
            const current = await this.#readRequiredAgent(txCtx, observation.agentId);
            await this.#authorize(txCtx, actingAgentId, current, "read");
            const sameRunVersion =
                current.runVersion === observation.version && current.runId === observation.runId;
            if (
                observation.version < current.runVersion ||
                (observation.version === current.runVersion &&
                    current.runId !== undefined &&
                    current.runId !== observation.runId) ||
                (sameRunVersion &&
                    current.observationUpdatedAt !== undefined &&
                    observation.updatedAt !== undefined &&
                    observation.updatedAt < current.observationUpdatedAt) ||
                (sameRunVersion &&
                    current.status !== observation.status &&
                    (observation.updatedAt === undefined ||
                        (current.observationUpdatedAt !== undefined &&
                            observation.updatedAt <= current.observationUpdatedAt)))
            ) {
                throw new Error(`Collaboration observation for "${observation.agentId}" is stale.`);
            }
            const statusChanged = current.status !== observation.status;
            const runChanged =
                current.runVersion !== observation.version || current.runId !== observation.runId;
            const observationTimestampChanged =
                observation.updatedAt !== undefined &&
                observation.updatedAt !== current.observationUpdatedAt;
            const base =
                observation.updatedAt === undefined && !sameRunVersion
                    ? withoutObservationUpdatedAt(current)
                    : current;
            const next: CollaborationAgent = {
                ...base,
                status: observation.status,
                runId: observation.runId,
                runVersion: observation.version,
                ...(observation.updatedAt === undefined
                    ? {}
                    : { observationUpdatedAt: observation.updatedAt }),
                ...(statusChanged || runChanged || observationTimestampChanged
                    ? { updatedAt: this.#now() }
                    : {}),
            };
            this.#assertAgent(next);
            if (sameValue(next, current)) return;
            await this.#writeAgent(txCtx, next);
            const persisted = await this.#readRequiredAgent(txCtx, observation.agentId);
            if (!sameValue(persisted, next)) {
                throw new Error("Collaboration roster substituted agent observation state.");
            }
            if (statusChanged) {
                const event = await this.#event(txCtx, {
                    type: "agent_status_changed",
                    actingAgentId,
                    agentId: observation.agentId,
                    status: observation.status,
                });
                await this.#announce(txCtx, event);
            }
        });
    }

    async #setStatus(
        ctx: Context,
        agentId: string,
        status: CollaborationAgent["status"],
    ): Promise<void> {
        const current = await this.#readRequiredAgent(ctx, agentId);
        if (current.status === status) return;
        const updated: CollaborationAgent = {
            ...current,
            status,
            updatedAt: this.#now(),
        };
        this.#assertAgent(updated);
        await this.#writeAgent(ctx, updated);
        const persisted = await this.#readRequiredAgent(ctx, agentId);
        if (!sameValue(persisted, updated)) {
            throw new Error("Collaboration roster substituted agent status.");
        }
        const event = await this.#event(ctx, {
            type: "agent_status_changed",
            actingAgentId: agentId,
            agentId,
            status,
        });
        await this.#announce(ctx, event);
    }

    async #ensureLoopAgent(ctx: Context, agentId: string): Promise<void> {
        if ((await this.#readAgent(ctx, agentId)) !== undefined) return;
        const at = this.#now();
        await this.#writeAgent(ctx, {
            id: agentId,
            ownerAgentId: agentId,
            parentId: null,
            status: "idle",
            runVersion: 0,
            createdAt: at,
            updatedAt: at,
        });
    }

    async #event(
        ctx: Context,
        payload:
            | {
                  readonly type: "agent_created";
                  readonly actingAgentId: string;
                  readonly agent: CollaborationAgent;
              }
            | {
                  readonly type: "agent_status_changed";
                  readonly actingAgentId: string;
                  readonly agentId: string;
                  readonly status: CollaborationAgent["status"];
              }
            | {
                  readonly type: "message_sent";
                  readonly actingAgentId: string;
                  readonly message: CollaborationMessage;
                  readonly obligation?: CollaborationObligation;
              }
            | {
                  readonly type: "reply_answered";
                  readonly actingAgentId: string;
                  readonly obligationId: string;
                  readonly answerMessageId: string;
              },
    ): Promise<CollaborationEvent> {
        const eventId = await this.#eventIdFactory(ctx, payload.actingAgentId);
        this.#assertValue(collaborationEventIdSchema, eventId, "event identity");
        const event = cloneAndFreezeEvent({
            ...payload,
            eventId,
            at: this.#now(),
        });
        return event;
    }

    async #announce(ctx: Context, event: CollaborationEvent): Promise<void> {
        const frozen = cloneAndFreezeEvent(event);
        await invokeVoid(
            this.#listener?.onEventTransactional?.(ctx, frozen),
            "Collaboration transactional listener",
        );
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, frozen));
    }

    async #notifyPostCommit(ctx: Context, event: CollaborationEvent): Promise<void> {
        try {
            await invokeVoid(
                this.#listener?.onEvent?.(ctx, event),
                "Collaboration post-commit listener",
            );
        } catch (error: unknown) {
            try {
                await invokeVoid(
                    this.#onPostCommitError?.(ctx, event, error),
                    "Collaboration post-commit error handler",
                );
            } catch {
                // Post-commit observation is advisory and cannot undo a committed mutation.
            }
        }
    }

    async #assertBrokerConfig(
        ctx: Context,
        id: string,
        expected: Static<typeof agentConfigSchema>,
    ): Promise<void> {
        const raw: unknown = this.#broker.config(ctx, id);
        const actual = await requirePromise(raw, "Collaboration broker config");
        if (actual === undefined) {
            throw new Error(
                `Collaboration broker did not persist Agent Base configuration for "${id}".`,
            );
        }
        this.#assertValue(agentConfigSchema, actual, "broker configuration");
        if (isRecord(actual) && actual.metadata !== undefined) {
            this.#assertMetadata(actual.metadata);
        }
        const detached = structuredClone(actual);
        if (!sameValue(detached, expected)) {
            throw new Error(`Agent "${id}" has a different Agent Base configuration.`);
        }
    }

    async #assertBrokerSelection(
        ctx: Context,
        id: string,
        expected: Static<typeof collaborationAgentSelectionSchema>,
    ): Promise<void> {
        const raw: unknown = this.#broker.selection(ctx, id);
        const actual = await requirePromise(raw, "Collaboration broker selection");
        if (actual === undefined) {
            throw new Error(`Collaboration broker did not persist selection for "${id}".`);
        }
        this.#assertValue(collaborationAgentSelectionSchema, actual, "broker selection");
        if (!sameValue(structuredClone(actual), expected)) {
            throw new Error(`Agent "${id}" has a different collaborator model selection.`);
        }
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        target: CollaborationAgent,
        action: Static<
            (typeof collaborationAuthorizationSchema.properties.authorize.parameters)[3]
        >,
    ): Promise<void> {
        if (target.id === actingAgentId || target.ownerAgentId === actingAgentId) return;
        const acting = await this.#readAgent(ctx, actingAgentId);
        if (
            acting !== undefined &&
            (acting.ownerAgentId === target.id || acting.parentId === target.id)
        ) {
            return;
        }
        if (this.#authorization === undefined) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} agent "${target.id}".`,
            );
        }
        const raw: unknown = this.#authorization.authorize(ctx, actingAgentId, target.id, action);
        const allowed = await requirePromise(raw, "Collaboration authorization");
        if (typeof allowed !== "boolean") {
            throw new Error("Collaboration authorization returned a non-boolean result.");
        }
        if (!allowed) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} agent "${target.id}".`,
            );
        }
    }

    async #generatedId<ValueSchema extends TSchema>(
        ctx: Context,
        actingAgentId: string,
        factory: (ctx: Context, actingAgentId: string) => string | Promise<string>,
        schema: ValueSchema,
        label: string,
    ): Promise<string> {
        const generated = await factory(ctx, actingAgentId);
        this.#assertValue(schema, generated, `${label} identity`);
        return generated;
    }

    #now(): number {
        const at = this.#clock();
        this.#assertValue(Type.Integer({ minimum: 0 }), at, "clock value");
        return at;
    }

    async #readAgent(ctx: Context, id: string): Promise<CollaborationAgent | undefined> {
        const raw: unknown = this.#roster.readAgent(ctx, id);
        const value = await requirePromise(raw, "Collaboration roster readAgent");
        if (value !== undefined) this.#assertAgent(value);
        return value === undefined ? undefined : structuredClone(value);
    }

    async #readRequiredAgent(ctx: Context, id: string): Promise<CollaborationAgent> {
        const value = await this.#readAgent(ctx, id);
        if (value === undefined) throw new Error(`Collaboration agent "${id}" does not exist.`);
        await this.#validateAgentReferences(ctx, value);
        return value;
    }

    async #validateAgentReferences(ctx: Context, agent: CollaborationAgent): Promise<void> {
        if (
            agent.ownerAgentId !== agent.id &&
            (await this.#readAgent(ctx, agent.ownerAgentId)) === undefined
        ) {
            throw new Error(`Collaboration agent "${agent.id}" has a missing owner.`);
        }
        const seen = new Set<string>();
        let current = agent;
        for (let depth = 0; depth <= 100; depth += 1) {
            if (seen.has(current.id)) {
                throw new Error(`Collaboration agent "${agent.id}" has cyclic parentage.`);
            }
            seen.add(current.id);
            if (current.parentId === null) return;
            const parent = await this.#readAgent(ctx, current.parentId);
            if (parent === undefined) {
                throw new Error(`Collaboration agent "${agent.id}" has a missing parent.`);
            }
            current = parent;
        }
        throw new Error(`Collaboration agent "${agent.id}" exceeds the parentage depth bound.`);
    }

    async #writeAgent(ctx: Context, agent: CollaborationAgent): Promise<void> {
        const expected = structuredClone(agent);
        const raw: unknown = this.#roster.writeAgent(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration roster writeAgent"),
            "roster writeAgent",
        );
        const persisted = await this.#readAgent(ctx, expected.id);
        if (persisted === undefined || !sameValue(persisted, expected)) {
            throw new Error("Collaboration roster substituted the written agent.");
        }
    }

    async #readMessage(ctx: Context, id: string): Promise<CollaborationMessage | undefined> {
        const raw: unknown = this.#store.readMessage(ctx, id);
        const value = await requirePromise(raw, "Collaboration store readMessage");
        if (value !== undefined) this.#assertMessage(value);
        return value === undefined ? undefined : structuredClone(value);
    }

    async #readRequiredMessage(ctx: Context, id: string): Promise<CollaborationMessage> {
        const value = await this.#readMessage(ctx, id);
        if (value === undefined) throw new Error(`Collaboration message "${id}" does not exist.`);
        return value;
    }

    async #writeMessage(ctx: Context, message: CollaborationMessage): Promise<void> {
        const expected = structuredClone(message);
        const raw: unknown = this.#store.writeMessage(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration store writeMessage"),
            "store writeMessage",
        );
        const persisted = await this.#readMessage(ctx, expected.id);
        if (persisted === undefined || !sameValue(persisted, expected)) {
            throw new Error("Collaboration store substituted the written message.");
        }
    }

    async #readObligation(ctx: Context, id: string): Promise<CollaborationObligation | undefined> {
        const raw: unknown = this.#store.readObligation(ctx, id);
        const value = await requirePromise(raw, "Collaboration store readObligation");
        if (value !== undefined) {
            this.#assertObligation(value);
            const message = await this.#readMessage(ctx, value.messageId);
            if (
                message === undefined ||
                message.obligationId !== value.id ||
                message.fromAgentId !== value.requesterAgentId ||
                message.toAgentId !== value.responderAgentId
            ) {
                throw new Error("Collaboration obligation has invalid message references.");
            }
            if (value.status === "answered") {
                const answer = await this.#readMessage(ctx, value.answerMessageId);
                if (
                    answer === undefined ||
                    answer.id !== value.answerMessageId ||
                    answer.fromAgentId !== value.responderAgentId ||
                    answer.toAgentId !== value.requesterAgentId ||
                    answer.replyTo !== value.id
                ) {
                    throw new Error(
                        "Collaboration answered obligation has an invalid answer message reference.",
                    );
                }
            }
        }
        return value === undefined ? undefined : structuredClone(value);
    }

    async #readRequiredObligation(ctx: Context, id: string): Promise<CollaborationObligation> {
        const value = await this.#readObligation(ctx, id);
        if (value === undefined) {
            throw new Error(`Collaboration reply obligation "${id}" does not exist.`);
        }
        return value;
    }

    async #writeObligation(ctx: Context, obligation: CollaborationObligation): Promise<void> {
        const expected = structuredClone(obligation);
        const raw: unknown = this.#store.writeObligation(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration store writeObligation"),
            "store writeObligation",
        );
        const persisted = await this.#readObligation(ctx, expected.id);
        if (persisted === undefined || !sameValue(persisted, expected)) {
            throw new Error("Collaboration store substituted the written obligation.");
        }
    }

    /** Render a complete roster page while keeping every returned identity and cursor visible. */
    formatAgentPageForModel(page: CollaborationAgentPage): string {
        assertCollaborationAgentPage(page);
        this.#assertAgentPageInvariants(page);
        const rows = page.agents.map(
            (agent) =>
                `${agent.id}${agent.role === undefined ? "" : ` (${agent.role})`}: ${agent.status}`,
        );
        const suffix =
            page.nextCursor === undefined
                ? ""
                : `\nMore collaborators start at cursor ${page.nextCursor}.`;
        const text = `${rows.join("\n") || "No collaborators."}${suffix}`;
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Collaboration roster page exceeds its model-output bound.");
        }
        return text;
    }

    #assertPageLimit(limit: number, kind: string): void {
        if (limit > this.#maxPageSize) {
            throw new Error(`${kind} page limit cannot exceed ${this.#maxPageSize}.`);
        }
    }

    #assertReturnedPage(
        pageLimit: number,
        itemCount: number,
        requestedLimit: number,
        kind: string,
    ): void {
        if (pageLimit > requestedLimit || itemCount > pageLimit) {
            throw new Error(`Collaboration roster returned too many ${kind}.`);
        }
    }

    #fittingAgentCount(page: CollaborationAgentPage): number {
        for (let count = page.agents.length; count >= 1; count -= 1) {
            const candidate = {
                ...page,
                agents: page.agents.slice(0, count),
            };
            const rows = candidate.agents.map(
                (agent) =>
                    `${agent.id}${agent.role === undefined ? "" : ` (${agent.role})`}: ${agent.status}`,
            );
            const suffix =
                candidate.nextCursor === undefined
                    ? ""
                    : `\nMore collaborators start at cursor ${candidate.nextCursor}.`;
            if (
                `${rows.join("\n") || "No collaborators."}${suffix}`.length <=
                this.#maxOutputCharacters
            ) {
                return count;
            }
        }
        return 0;
    }

    #assertAgentPageInvariants(page: CollaborationAgentPage): void {
        const seen = new Set<string>();
        let previous: string | undefined;
        for (const agent of page.agents) {
            this.#assertAgent(agent);
            if (
                seen.has(agent.id) ||
                (previous !== undefined && agent.id.localeCompare(previous) <= 0)
            ) {
                throw new Error("Collaboration roster returned duplicate or unordered agents.");
            }
            seen.add(agent.id);
            previous = agent.id;
        }
    }

    #assertCursorProgress(
        nextCursor: string | undefined,
        requestedCursor: string | undefined,
        itemCount: number,
        kind: string,
    ): void {
        if (nextCursor !== undefined && (itemCount === 0 || nextCursor === requestedCursor)) {
            throw new Error(`Collaboration ${kind} page cursor did not make progress.`);
        }
        if (nextCursor === undefined || requestedCursor === undefined) return;
        const previousNumber = Number(requestedCursor);
        const nextNumber = Number(nextCursor);
        if (
            Number.isSafeInteger(previousNumber) &&
            Number.isSafeInteger(nextNumber) &&
            requestedCursor.trim() !== "" &&
            nextCursor.trim() !== "" &&
            nextNumber <= previousNumber
        ) {
            throw new Error(`Collaboration ${kind} page cursor did not advance.`);
        }
    }

    #assertAgentId(value: unknown, label: string): asserts value is string {
        this.#assertValue(collaborationAgentIdSchema, value, `${label} ID`);
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        this.#assertValue(schema, value, label);
    }

    #assertValue(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid collaboration ${label}.`);
    }

    #assertMetadata(value: unknown): asserts value is CollaborationMetadata {
        assertBoundedMetadata(value);
    }

    #assertAgent(value: unknown): asserts value is CollaborationAgent {
        if (isRecord(value) && value.metadata !== undefined) {
            assertBoundedMetadata(value.metadata);
        }
        this.#assertValue(collaborationAgentSchema, value, "agent");
        const agent = value as CollaborationAgent;
        if (agent.createdAt > agent.updatedAt || agent.parentId === agent.id) {
            throw new Error("Collaboration agent has invalid timestamp or parent invariants.");
        }
        this.#assertMetadataIfPresent(value as CollaborationAgent);
    }

    #assertMetadataIfPresent(value: CollaborationAgent): void {
        if (value.metadata !== undefined) this.#assertMetadata(value.metadata);
    }

    #assertMessage(value: unknown): asserts value is CollaborationMessage {
        if (isRecord(value) && value.metadata !== undefined) {
            assertBoundedMetadata(value.metadata);
        }
        this.#assertValue(collaborationMessageSchema, value, "message");
        if ((value as CollaborationMessage).metadata !== undefined) {
            this.#assertMetadata((value as CollaborationMessage).metadata);
        }
    }

    #assertObligation(value: unknown): asserts value is CollaborationObligation {
        this.#assertValue(collaborationObligationSchema, value, "obligation");
        const obligation = value as CollaborationObligation;
        if (obligation.createdAt > obligation.updatedAt) {
            throw new Error("Collaboration obligation timestamps are invalid.");
        }
    }

    #assertSendResult(value: unknown): asserts value is CollaborationSendResult {
        this.#assertValue(collaborationSendResultSchema, value, "send result");
        this.#assertMessage((value as CollaborationSendResult).message);
        if ((value as CollaborationSendResult).obligation !== undefined) {
            this.#assertObligation((value as CollaborationSendResult).obligation);
        }
    }
}

function validateOptions(options: unknown): CollaborationModuleOptions {
    if (typeof options !== "object" || options === null) {
        throw new Error("Collaboration module options are invalid.");
    }
    const source = options as Record<string, unknown>;
    const view = {
        ...source,
        broker: methodView(source.broker, [
            "create",
            "config",
            "selection",
            "send",
            "wait",
            "interrupt",
            "observe",
            "waitForAgent",
            "setReadOnly",
            "spawnCapacity",
        ]),
        ...(source.authorization === undefined
            ? {}
            : { authorization: methodView(source.authorization, ["authorize"]) }),
        ...(source.listener === undefined
            ? {}
            : {
                  listener: methodView(source.listener, ["onEventTransactional", "onEvent"]),
              }),
    };
    if (!Value.Check(collaborationModuleOptionsSchema, view)) {
        throw new Error("Collaboration module options are invalid.");
    }
    return options as CollaborationModuleOptions;
}

function methodView(value: unknown, keys: readonly string[]): unknown {
    if (typeof value !== "object" || value === null) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const source = value as Record<string, unknown>;
    const view: Record<string, unknown> = {};
    for (const key of keys) view[key] = source[key];
    return view;
}

function assertModelCatalog(value: CollaborationModelCatalog): void {
    const pairs = new Set<string>();
    for (const model of value.availableModels) {
        if (!model.effortLevels.includes(model.defaultEffort)) {
            throw new Error(`Model "${model.id}" has a default effort it does not support.`);
        }
        const pair = `${model.providerId}\u0000${model.id}`;
        if (pairs.has(pair)) {
            throw new Error(
                `Model "${model.id}" is duplicated for provider "${model.providerId}".`,
            );
        }
        pairs.add(pair);
    }
    const disabled = new Set<string>();
    for (const provider of value.disabledProviders) {
        if (disabled.has(provider.id)) {
            throw new Error(`Provider "${provider.id}" is duplicated in the disabled catalog.`);
        }
        disabled.add(provider.id);
    }
}

function normalizeFork(
    context: CollaborationCreateInput["context"],
    forkTurns: CollaborationCreateInput["forkTurns"],
): {
    readonly context: "parent" | "task";
    readonly forkTurns?: CollaborationCreateInput["forkTurns"];
} {
    if (forkTurns === undefined) {
        return { context: context ?? "task" };
    }
    const derivedContext = forkTurns === "none" ? "task" : "parent";
    if (context !== undefined && context !== derivedContext) {
        throw new Error("Collaboration context and forkTurns request different contexts.");
    }
    return {
        context: derivedContext,
        forkTurns,
    };
}

/**
 * `false` means inherit the sender's mode. A read-only sender must never be able to turn that
 * request into a wider child mode, so the broker receives the equivalent explicit reduction.
 */
function normalizeReadOnly(
    mode: AgentPermissionMode,
    requested: boolean | undefined,
): boolean | undefined {
    return requested === false && mode === "read_only" ? true : requested;
}

function withoutObservationUpdatedAt(
    agent: CollaborationAgent,
): Omit<CollaborationAgent, "observationUpdatedAt"> {
    const { observationUpdatedAt: _observationUpdatedAt, ...rest } = agent;
    return rest;
}

function truncateForModel(text: string, maximum: number, marker: string): string {
    if (text.length <= maximum) return text;
    if (marker.length >= maximum) return marker.slice(0, maximum);
    return `${text.slice(0, maximum - marker.length)}${marker}`;
}

function isInterruptibleStatus(status: CollaborationAgentObservation["status"]): boolean {
    return status === "active" || status === "running";
}

function isTerminalInterruptStatus(status: CollaborationAgentObservation["status"]): boolean {
    return (
        status === "completed" ||
        status === "error" ||
        status === "aborted" ||
        status === "suspended"
    );
}

function mergedMetadata(
    configMetadata: unknown,
    inputMetadata: CollaborationMetadata | undefined,
): CollaborationMetadata | undefined {
    if (configMetadata === undefined && inputMetadata === undefined) return undefined;
    const merged = {
        ...(isRecord(configMetadata) ? configMetadata : {}),
        ...inputMetadata,
    };
    assertBoundedMetadata(merged);
    return merged;
}

function collaborationMessageMetadata(
    inputMetadata: CollaborationMetadata | undefined,
    messageId: string,
    fromAgentId: string,
    toAgentId: string,
    obligationId: string | undefined,
    replyTo: string | undefined,
): CollaborationMetadata {
    const metadata = {
        ...inputMetadata,
        collaboration: {
            messageId,
            fromAgentId,
            toAgentId,
            ...(obligationId === undefined ? {} : { obligationId }),
            ...(replyTo === undefined ? {} : { replyTo }),
        },
    };
    assertBoundedMetadata(metadata);
    return metadata;
}

function assertBoundedMetadata(value: unknown): asserts value is CollaborationMetadata {
    const seen = new WeakSet<object>();
    visitMetadata(value, 0, seen);
    if (!Value.Check(collaborationMetadataSchema, value)) {
        throw new Error("Collaboration metadata is invalid.");
    }
    let encoded: Uint8Array;
    try {
        encoded = new TextEncoder().encode(canonicalString(value));
    } catch {
        throw new Error("Collaboration metadata could not be encoded.");
    }
    if (encoded.byteLength > COLLABORATION_METADATA_MAX_ENCODED_BYTES) {
        throw new Error("Collaboration metadata exceeds its encoded byte bound.");
    }
}

function visitMetadata(value: unknown, depth: number, seen: WeakSet<object>): void {
    if (value === null || typeof value !== "object") {
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new Error("Collaboration metadata numbers must be finite.");
        }
        return;
    }
    if (seen.has(value)) throw new Error("Collaboration metadata must be acyclic.");
    if (depth > COLLABORATION_METADATA_MAX_DEPTH) {
        throw new Error("Collaboration metadata exceeds its nesting depth.");
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const child of value) visitMetadata(child, depth + 1, seen);
    } else {
        for (const child of Object.values(value)) visitMetadata(child, depth + 1, seen);
    }
    seen.delete(value);
}

function canonicalString(value: unknown): string {
    const result = JSON.stringify(sortCanonicalValue(value));
    if (typeof result !== "string") throw new Error("Collaboration value is not canonical JSON.");
    return result;
}

function sortCanonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortCanonicalValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, sortCanonicalValue(value[key])]),
    );
}

function sameValue(left: unknown, right: unknown): boolean {
    try {
        return canonicalString(left) === canonicalString(right);
    } catch {
        return false;
    }
}

function cloneAndFreezeEvent(event: CollaborationEvent): CollaborationEvent {
    if (!Value.Check(collaborationEventSchema, event)) {
        throw new Error("Collaboration module created an invalid event.");
    }
    const cloned = structuredClone(event);
    if (!Value.Check(collaborationEventSchema, cloned)) {
        throw new Error("Collaboration module created an invalid cloned event.");
    }
    return deepFreeze(cloned);
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

function generatedId(prefix: string): string {
    return `${prefix}${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`;
}

async function requirePromise<ValueType>(value: unknown, operation: string): Promise<ValueType> {
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    return (await value) as ValueType;
}

async function invokeVoid(value: unknown, operation: string): Promise<void> {
    if (value === undefined) return;
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return undefined or Promise<void>.`);
    }
    const result = await value;
    if (result !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
