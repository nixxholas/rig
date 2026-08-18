import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    AgentEvent,
    EventsModule,
    EventsModuleListener,
    HappyAgentConfiguration,
    SchedulingModule,
    UserInputModule,
    UserInputRequest,
    WorkspacesModule,
} from "@slopus/happy-agent-modules";
import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";
import { afterCommit, detach, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import type {
    ConversationModule,
    ConversationRecord,
} from "../conversations/ConversationModule.js";
import { agentMessageOptions, type RequestedAgentSelection } from "../http/agentMessageOptions.js";
import { createRigModelCatalog } from "../http/rigProtocol.js";
import {
    resolveSessionOwner,
    sessionAgentConfig,
    sessionSummaryValue,
} from "../http/sessionRoutes.js";
import {
    catalogSelection,
    persistSessionSelection,
    selectionFromMessageOptions,
    sessionSelection,
    type SessionSelection,
} from "../http/sessionSelection.js";
import { importHappyCredentials } from "./credentials/importHappyCredentials.js";
import type { HappySpawnOperations } from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import { HappyMachineClient } from "./HappyMachineClient.js";
import type {
    HappyInboundMessage,
    HappyModel,
    HappySessionSnapshot,
    HappySpawnRequest,
} from "./HappySession.js";
import { HappySessionClient, type HappySessionOperations } from "./HappySessionClient.js";
import { createHappySyncDatabase, happySyncMigrations } from "./HappySyncDatabase.js";
import { resolveHappyUserInputAnswers } from "./resolveHappyUserInputAnswers.js";
import { HappyMessageMapper } from "./mapHappyMessages.js";

/** How many agents one daemon keeps connected to Happy at once. */
const MAX_CONNECTED_AGENTS = 64;

/**
 * Everything Happy works through, all of it settled before the agent collection opens.
 *
 * The credentials folder and the version this build reports come out of the configuration rather
 * than from a caller, so nothing about talking to Happy has to be handed in from outside. The agent
 * collection is the one exception, because creating it is what starts these modules; it arrives at
 * `beforeStart`.
 */
export interface HappyModuleOptions {
    readonly configuration: HappyAgentConfiguration;
    readonly conversations: ConversationModule;
    /** The journal Happy projects, and writes its own session events to. */
    readonly events: EventsModule;
    readonly fetch?: typeof fetch;
    /**
     * The root agent's identity, which the installation only settles as these modules start,
     * so it is asked for rather than captured.
     */
    readonly rootAgentId: () => string;
    readonly scheduling: SchedulingModule;
    readonly userInput: UserInputModule;
    readonly workspaces: WorkspacesModule;
}

interface ConnectedAgent {
    readonly client: HappySessionClient;
    readonly mapper: HappyMessageMapper;
}

/**
 * The connection between this daemon and Happy, the mobile app.
 *
 * A session running here shows up on the phone, streams as it works, and can be driven from there.
 * That happens because every durable event is turned into Happy's own messages and queued in the
 * same transaction that recorded it, so what the phone sees is exactly the history Rig kept, in the
 * order it happened.
 *
 * The socket, the encryption and the queue are this module's own. The conversation is not, and it
 * is not reinvented here either: every act on one goes through the same catalogs and the same
 * journal the daemon's HTTP routes write to. That is deliberate. A session driven from the phone
 * and the same session driven from a desktop client leave identical history behind, because both
 * end in the same writes.
 *
 * Signing in belongs to Happy itself. If there are no credentials on this machine, this module
 * simply does nothing; that is not an error, it is somebody who has not connected their phone.
 */
export class HappyModule
    implements AgentModule<AnyAgentTool>, HappySessionOperations, HappySpawnOperations
{
    readonly name = "happy";
    readonly migrations = happySyncMigrations;
    readonly #agents = new Map<string, ConnectedAgent>();
    readonly #options: HappyModuleOptions;
    readonly #sync = createHappySyncDatabase();
    #agentSystem: AgentSystemRef<LibSQLDatabase> | undefined;
    #configuration: HappyConnectionConfiguration | undefined;
    #context: Context | undefined;
    #fingerprint = "";
    #machine: HappyMachineClient | undefined;

    constructor(options: HappyModuleOptions) {
        this.#options = options;
        // The journal must know who projects it from the moment it records anything, and there is
        // nowhere earlier than here to say so.
        options.events.observe(this.#eventsListener);
    }

    /**
     * Watches the durable journal.
     *
     * Projection runs in the recording transaction, which is what makes the queue and the history
     * one fact rather than two that might disagree.
     */
    readonly #eventsListener: EventsModuleListener = {
        onEvent: (ctx: Context, event: AgentEvent): void => {
            if (event.agentId === undefined) return;
            this.#agents.get(event.agentId)?.client.kick();
        },
        onEventTransactional: async (ctx: Context, event: AgentEvent): Promise<void> => {
            if (this.#configuration === undefined || event.agentId === undefined) return;
            if (event.type === "agent.archived") {
                await this.#detach(ctx, event.agentId);
                return;
            }
            const attached = await this.#attach(ctx, event.agentId);
            if (attached === undefined) return;
            await this.#sync.projectEvent(ctx, {
                agentId: event.agentId,
                eventId: event.id,
                messages: attached.mapper.map(event).map((message) => ({
                    localId: message.localId,
                    payload: message,
                })),
                now: Date.now(),
            });
        },
    };

    /**
     * Takes this module's own lifetime, then connects to Happy once the agents are running.
     *
     * Connecting is `afterStart` rather than `beforeStart` on purpose. Publishing a session means
     * describing what it is doing, and until every durable agent has been restored there is no
     * honest answer to give — a phone would be shown a row of sessions that all look idle, and then
     * watch them correct themselves.
     */
    readonly beforeStart = (
        ctx: Context,
        agents: AgentSystemRef<LibSQLDatabase>,
    ): AgentModuleHooks => {
        // Talking to Happy outlives whatever asked the agent to start, so it takes its own
        // lifetime; detaching drops the database with the caller's, so it is carried over.
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Happy was started without an agent database.");
        }
        this.#context = withAgentDatabase(detach(ctx).named("happy"), database);
        this.#agentSystem = agents;
        return { afterStart: async (startedCtx) => await this.#connect(startedCtx) };
    };

    async #connect(ctx: Context): Promise<void> {
        const context = this.#context;
        if (context === undefined) return;
        // Credentials are the switch: a machine that has never been paired with Happy has said
        // everything there is to say about whether it wants to talk to it.
        const configuration = await importHappyCredentials({
            dataDirectory: this.#options.configuration.paths.agentHome,
        });
        if (configuration === undefined) {
            ctx.log.debug("Happy is not connected on this machine.");
            return;
        }
        this.#configuration = configuration;
        this.#fingerprint = fingerprint(configuration);
        // Without a machine identity this computer cannot be picked on the phone, so there is
        // nothing to register. Sessions started here still appear, which is the part that matters.
        if (configuration.machineId === undefined) {
            ctx.log.debug("Happy has no machine identity for this computer.");
            return;
        }
        this.#machine = new HappyMachineClient({
            configuration,
            context,
            ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
            models: () => this.models(),
            operations: this,
            remoteSessionId: async (agentId) =>
                (await this.#sync.readSession(context, agentId))?.remoteSessionId,
            version: this.#options.configuration.version,
        });
        this.#machine.start();
    }

    /** Stops talking to Happy, which the daemon does as it shuts down. */
    async stop(): Promise<void> {
        this.#machine?.close();
        this.#machine = undefined;
        const agents = [...this.#agents.values()];
        this.#agents.clear();
        await Promise.all(agents.map(async (agent) => agent.client.close()));
    }

    /** Sends everything owed and waits for it, which is what a shutdown and a test need. */
    async settle(): Promise<void> {
        await Promise.all([...this.#agents.values()].map(async (agent) => agent.client.settle()));
    }

    /** Every model the phone may offer, across providers. */
    models(): readonly HappyModel[] {
        // `AgentModel` carries no context window, so that optional field of `HappyModel` is left
        // off rather than guessed at.
        return this.#system().models.map((model) => ({
            defaultEffort: model.defaultEffort,
            effortLevels: [...model.effortLevels],
            id: model.id,
            name: model.name,
            providerId: model.providerId,
            serviceTiers: model.serviceTiers === undefined ? [] : [...model.serviceTiers],
        }));
    }

    /** One session as Happy needs to describe it, or nothing when it is gone. */
    async session(ctx: Context, agentId: string): Promise<HappySessionSnapshot | undefined> {
        const session = await this.#options.conversations.getByAgent(ctx, agentId);
        if (session === undefined) return undefined;
        return await this.#snapshot(ctx, session);
    }

    /** Delivers what a person said on the phone, and what they chose to say it with. */
    async submit(ctx: Context, agentId: string, message: HappyInboundMessage): Promise<void> {
        const options = this.#options;
        const session = await options.conversations.getByAgent(ctx, agentId);
        if (session === undefined) {
            throw new Error(`No session is running for agent "${agentId}".`);
        }
        const fallback = this.#catalogSelection();
        const current = sessionSelection(session, fallback);
        // What the phone named wins where it named something; the session's current selection
        // stands in for everything it left alone, exactly as a desktop message would.
        const requested: RequestedAgentSelection = {
            effort: message.selection.effort ?? current.effort,
            model: message.selection.modelId ?? current.modelId,
            provider: message.selection.providerId ?? current.providerId,
            serviceTier: current.serviceTier,
            permissionMode: message.selection.permissionMode ?? current.permissionMode,
        };
        const messageOptions = agentMessageOptions(this.#system().models, requested);
        // The phone already shows what a person sent; stamping the message with its remote identity
        // is what lets the projection recognize the echo and not draw it a second time. The
        // human-origin marker `agentMessageOptions` set is kept, because this is a person typing.
        const stamped = {
            ...messageOptions,
            metadata: {
                ...messageOptions.metadata,
                happy: { remoteMessageId: message.remoteMessageId },
            },
        };
        try {
            await this.#system().send(ctx, agentId, messageFrom(message), stamped);
        } catch (cause) {
            throw new Error("Agent Base rejected the phone's message.", { cause });
        }
        // A queued message does not reach the conversation until the current turn ends, and a wait
        // is a turn held open; a person writing into the chat is what ends it.
        options.scheduling.interruptWaits(ctx, agentId);
        await persistSessionSelection(
            ctx,
            { conversations: options.conversations, events: options.events },
            session,
            selectionFromMessageOptions(messageOptions, current),
            fallback,
        );
    }

    /** Stops whatever the agent is doing. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        await this.#system().abort(ctx, agentId);
    }

    /** Ends a session, as the phone's kill switch does. */
    async archiveSession(ctx: Context, sessionId: string): Promise<void> {
        await this.#options.conversations.update(ctx, sessionId, {
            archived: true,
            status: "archived",
        });
    }

    /** The questions this agent is waiting on right now. */
    async pendingQuestions(ctx: Context, agentId: string): Promise<readonly UserInputRequest[]> {
        return await this.#options.userInput.list(ctx, agentId, { status: "pending" });
    }

    /** Records what a person answered on the phone. */
    async answerQuestion(
        ctx: Context,
        agentId: string,
        requestId: string,
        answers: Record<string, unknown>,
    ): Promise<void> {
        // The stored question decides how the phone's raw answers are read, so it is read first; a
        // question that is no longer waiting cannot be answered.
        const userInput = this.#options.userInput;
        const pending = await userInput.list(ctx, agentId, { status: "pending" });
        const request = pending.find((candidate) => candidate.id === requestId);
        if (request === undefined) {
            throw new Error(`Question "${requestId}" is no longer waiting for an answer.`);
        }
        await userInput.answer(ctx, agentId, resolveHappyUserInputAnswers(request, answers));
    }

    /** Dismisses a question the person chose not to answer. */
    async cancelQuestion(ctx: Context, agentId: string, requestId: string): Promise<void> {
        await this.#options.userInput.cancel(ctx, agentId, {
            reason: "Dismissed from the phone.",
            requestId,
        });
    }

    /**
     * Starts a session in a directory the phone named.
     *
     * By the time this runs, `handleHappySpawnSession` has already checked and created the
     * directory and settled the model, reasoning level and permission mode against what this
     * daemon actually offers. What is left is opening the session, so failing here is a real
     * failure and throws.
     */
    async spawnSession(ctx: Context, request: HappySpawnRequest): Promise<{ agentId: string }> {
        const options = this.#options;
        const system = this.#system();
        // The reserved session id is stable across retries, so a conversation already carrying it
        // means the spawn happened; its agent is the answer rather than a second session.
        const existing = await options.conversations.get(ctx, request.sessionId);
        if (existing !== undefined) return { agentId: existing.agentId };

        const rootConfig = (await system.config(ctx, options.rootAgentId())) ?? {};
        const owner = await resolveSessionOwner(
            ctx,
            { rootAgentId: options.rootAgentId(), workspaces: options.workspaces },
            { cwd: request.cwd },
        );
        // Creating an agent writes its own conversation from defaults that know nothing of this
        // request. The row has to exist with the resolved folder, scope and selection before then,
        // or the session would be recorded in the wrong place with no way to move it afterwards.
        const agentId = createId();
        const session = await options.conversations.ensure(ctx, {
            agentId,
            cwd: owner.cwd,
            effort: request.effort,
            id: request.sessionId,
            modelId: request.modelId,
            permissionMode: request.permissionMode,
            providerId: request.providerId,
            scope: owner.scope,
        });
        const agent = await system.create(ctx, sessionAgentConfig(rootConfig, owner.cwd), {
            id: agentId,
        });
        const summary = sessionSummaryValue(
            session,
            createRigModelCatalog(system.models),
            this.#catalogSelection(),
        );
        await options.events.record(ctx, {
            agentId: agent.id,
            payload: { session: summary },
            type: "session.created",
        });
        await options.conversations.appendEvent(ctx, session.id, {
            payload: { agentId: agent.id },
            type: "session_created",
        });
        return { agentId: agent.id };
    }

    async #attach(ctx: Context, agentId: string): Promise<ConnectedAgent | undefined> {
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;
        const configuration = this.#configuration;
        const context = this.#context;
        if (configuration === undefined || context === undefined) return undefined;
        if (this.#agents.size >= MAX_CONNECTED_AGENTS) return undefined;
        const session = await this.session(ctx, agentId);
        if (session === undefined || session.archived) return undefined;
        await this.#sync.ensureSession(
            ctx,
            {
                agentId,
                credentialFingerprint: this.#fingerprint,
                encryptionKeyBase64: this.#sessionKey(),
                encryptionVariant: configuration.credentials.encryption.type,
                sessionId: session.sessionId,
            },
            Date.now(),
        );
        const attached: ConnectedAgent = {
            client: new HappySessionClient({
                agentId,
                configuration,
                context,
                ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
                operations: this,
                sessionId: session.sessionId,
                sync: this.#sync,
                version: this.#options.configuration.version,
            }),
            mapper: new HappyMessageMapper(),
        };
        this.#agents.set(agentId, attached);
        // The client talks to a session that does not exist until this commits.
        afterCommit(ctx, () => {
            attached.client.start();
        });
        return attached;
    }

    async #detach(ctx: Context, agentId: string): Promise<void> {
        const attached = this.#agents.get(agentId);
        this.#agents.delete(agentId);
        if (attached === undefined) return;
        afterCommit(ctx, () => {
            void attached.client.archive();
        });
    }

    /** One session, described in the terms Happy publishes it. */
    async #snapshot(ctx: Context, session: ConversationRecord): Promise<HappySessionSnapshot> {
        const selection = sessionSelection(session, this.#catalogSelection());
        const config = await this.#system().config(ctx, session.agentId);
        return {
            agentId: session.agentId,
            archived: session.archived,
            cwd: session.cwd,
            effort: selection.effort,
            modelId: selection.modelId,
            permissionMode: selection.permissionMode,
            projectName: projectNameFor(session),
            providerId: selection.providerId,
            ...(selection.serviceTier === null ? {} : { serviceTier: selection.serviceTier }),
            sessionId: session.id,
            status: session.archived ? "archived" : session.status,
            title: config?.metadata?.title ?? "Untitled session",
            // The daemon keeps no per-agent tool listing, so there is nothing honest to return here.
            tools: [],
            // This snapshot is built inside the transaction that recorded the event that asked for
            // it, where an agent cannot be resolved. The conversation's own status is the
            // transaction-safe answer to whether it is working, and the same one a client reads.
            working: session.status === "running" || session.status === "queued",
        };
    }

    /** This agent's catalog default selection, in the terms the shared selection helpers take. */
    #catalogSelection(): SessionSelection {
        return catalogSelection(
            this.#system().models,
            this.#options.configuration.values.defaults.permissionMode,
        );
    }

    /** The agent collection, or a clear refusal when something asked before this module started. */
    #system(): AgentSystemRef<LibSQLDatabase> {
        if (this.#agentSystem === undefined) {
            throw new Error("Happy was asked to act before its agents had started.");
        }
        return this.#agentSystem;
    }

    /**
     * The key this session's payloads are encrypted with.
     *
     * A `dataKey` account gets a fresh key per session, wrapped to the account's public key, so the
     * account secret itself never leaves the phone. A `legacy` account has only the one secret, and
     * uses it.
     */
    #sessionKey(): string {
        const encryption = this.#configuration?.credentials.encryption;
        if (encryption?.type === "legacy") {
            return Buffer.from(encryption.secret).toString("base64");
        }
        return randomBytes(32).toString("base64");
    }
}

/**
 * Identifies the account and server a session's rows belong to.
 *
 * Signing in as somebody else must not resume the previous person's session, so the stored rows
 * carry who they were written for.
 */
function fingerprint(configuration: HappyConnectionConfiguration): string {
    return createHash("sha256")
        .update(configuration.credentials.token)
        .update("\0")
        .update(configuration.serverUrl)
        .digest("hex")
        .slice(0, 32);
}

/** The person's message, with any attached images carried alongside the text. */
function messageFrom(message: HappyInboundMessage): SessionUserMessage {
    const content: SessionInputBlock[] = [];
    if (message.text.length > 0 || message.images.length === 0) {
        content.push({ text: message.text, type: "text" });
    }
    for (const image of message.images) {
        content.push({ data: image.data, mimeType: image.mimeType, type: "image" });
    }
    return { content, role: "user" };
}

/**
 * A human name for the folder a session works in.
 *
 * The working directory's own last segment is the honest answer, and the one a person recognizes:
 * it is the project or workspace folder they opened. The full path stands in only for a directory
 * that has no last segment to speak of.
 */
function projectNameFor(session: ConversationRecord): string {
    return basename(session.cwd) || session.cwd;
}
