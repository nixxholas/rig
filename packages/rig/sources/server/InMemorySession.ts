import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import { Executor } from "@slopus/rig-execution";
import { areProviderModelsCompatible } from "@slopus/rig-providers";

import { errorToMessage } from "../errorToMessage.js";
import { toLocalDate } from "../executor/toLocalDate.js";
import { assistantMessageToAgentMessage } from "../agent/assistantMessageToAgentMessage.js";
import { isInternalMessage } from "../agent/isInternalMessage.js";
import { findFirstUserRequestText, findLastAgentResponseText } from "../agent/index.js";
import type {
    AgentContext,
    AgentLoopEvent,
    AgentCompactionResult,
    AgentRunResult,
    AgentSnapshot,
    ContentBlock,
} from "../agent/index.js";
import type { Message, UserMessage } from "../agent/types.js";
import type { BashContext } from "../agent/context/BashContext.js";
import {
    createGoalContinuationPrompt,
    normalizeGoalObjective,
    type ChangeGoalStatusRequest,
    type CreateGoalRequest,
    type SessionGoal,
} from "../goals/index.js";
import type { CodingAssistantRuntime } from "../runtime/CodingAssistantRuntime.js";
import {
    createCodingAssistantAgent,
    type CreateCodingAssistantAgentOptions,
} from "../runtime/createCodingAssistantAgent.js";
import type {
    ChangeEffortRequest,
    AbortRunResponse,
    ChangeModelRequest,
    ChangePermissionModeRequest,
    ChangeServiceTierRequest,
    SessionConfigurationField,
    CreateSessionRequest,
    EventId,
    ModelCatalog,
    ProtocolSession,
    ReadBackgroundProcessResponse,
    RewindSessionResponse,
    RunShellCommandRequest,
    RunShellCommandResponse,
    RunShellCommandResult,
    SessionEvent,
    SessionAgentMetadata,
    SessionInterruption,
    SessionStatus,
    SessionSummary,
    SessionTokenCount,
    SessionUnreadState,
    ShellCommandFinishedEvent,
    StopBackgroundProcessResponse,
    SubagentSummary,
    SessionTitleStatus,
    SetSessionDraftRequest,
    SubmitMessageRequest,
    SubmitMessageResponse,
    SteerMessageRequest,
    SteerMessageResponse,
    UpdateSessionRequest,
} from "../protocol/index.js";
import { SESSION_DRAFT_MAX_LENGTH } from "../protocol/index.js";
import { clampSessionDraftTimestamp } from "./clampSessionDraftTimestamp.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { sessionUnreadStateAfterEvent } from "./sessionUnreadStateAfterEvent.js";
import { aggregateSessionTokenCount } from "../sessionTokenCount/aggregateSessionTokenCount.js";
import { sessionTokenCountAfterEvent } from "../sessionTokenCount/sessionTokenCountAfterEvent.js";
import type { Model, Provider, ServiceTier, StopReason, Usage } from "@slopus/rig-execution";
import type { ProviderQuota } from "@slopus/rig-providers";
import { createEncryptedAgentTransportScope } from "../executor/createEncryptedAgentTransportScope.js";
import type {
    DurableUserInputCall,
    DurableUserInputOptions,
    UserInputRequest,
    UserInputResponse,
} from "../user-input/index.js";
import {
    humanizeWorkflowName,
    serializeWorkflowValue,
    type LaunchWorkflowRequest,
    type WorkflowAgentCacheEntry,
    type WorkflowCheckpoint,
    type WorkflowRun,
    type WorkflowRunUpdate,
} from "../workflows/index.js";
import { createCodeReviewPrompt } from "../review/index.js";
import {
    createMcpTrustUserInputRequest,
    MCP_TRUST_ANSWER,
    mergeMcpTools,
    type McpServerSummary,
    type McpServerTrustRequest,
    type McpToolProvider,
} from "../mcp/index.js";
import type {
    CreateTaskRequest,
    SessionTask,
    UpdateTaskRequest,
    UpdateTaskResult,
} from "../tasks/index.js";
import { SessionTaskList } from "../tasks/index.js";
import {
    DEFAULT_PERMISSION_MODE,
    isPermissionReduction,
    parsePermissionMode,
    type PermissionMode,
} from "../permissions/index.js";
import { createSessionMetadataTranscript } from "./createSessionMetadataTranscript.js";
import { generateSessionMetadata } from "./generateSessionMetadata.js";
import { createAbortRequestKey } from "./createAbortRequestKey.js";
import { createGoalTitle } from "./createGoalTitle.js";
import { formatShellCommandContext } from "./formatShellCommandContext.js";
import { getProviderIdForModel } from "./getProviderIdForModel.js";
import { getProviderIdsForModel } from "./getProviderIdsForModel.js";
import { resolveInitialModelSelection } from "./resolveInitialModelSelection.js";
import { resolveSteeringContinuationMessageIds } from "./resolveSteeringContinuationMessageIds.js";
import { SessionEventLog } from "./SessionEventLog.js";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { summarizeDockerExecution } from "../execution/index.js";
import type { TaskDrain } from "./TrackedTaskDrain.js";
import {
    addUsage,
    aggregateSessionUsage,
    type SessionUsageSummary,
    zeroUsage,
} from "./sessionUsage/index.js";
import { createRequestDebugDirectory, DebugLog } from "../debug/index.js";
import { SecretRegistry, SessionSecretContext } from "../secrets/index.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import {
    createExternalTool,
    externalToolResolutionToContent,
    replaceExternalTools,
    type ExternalToolCall,
    type ExternalToolCallResolution,
    type ExternalToolDefinition,
    type ExternalToolInstallation,
    type ResolveExternalToolCallResponse,
} from "../external-tools/index.js";
import type { AgentMessage, ToolResultBlock } from "../agent/types.js";
import { createErrorToolResultBlock } from "../agent/createErrorToolResultBlock.js";
import { createToolResultBlock } from "../agent/createToolResultBlock.js";
import { createModelSwitchHistoryMessage } from "../agent/createModelSwitchHistoryMessage.js";
import { isCodexV2CollaborationModel } from "../agent/tools/codex/isCodexV2CollaborationModel.js";
import { createDurableSkillTool, type DurableSkillDefinition } from "../external-skills/index.js";

const MAX_RETAINED_EXTERNAL_TOOL_CALLS = 1_000;
const MAX_RETAINED_DURABLE_USER_INPUTS = 1_000;

export interface PersistedSessionMessage {
    isPartial: boolean;
    message: Message;
    position: number;
    runId?: string;
}

export interface PersistedQueuedRun {
    debug?: boolean;
    debugDirectory?: string;
    displayText: string;
    effort?: string;
    modelId?: string;
    providerId?: string;
    serviceTier?: ServiceTier | null;
    interactive?: boolean;
    kind: "goal" | "user";
    runId: string;
    text: string;
    userMessage: UserMessage;
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    systemPrompt?: string | null;
}

interface SessionSubmitMessageRequest extends SubmitMessageRequest {
    agentMessageTriggerTurn?: boolean;
    encryptedAgentMessage?: {
        author: string;
        recipient: string;
        header: string;
        encryptedContent: string;
    };
    provenance?: "agent";
}

export interface PersistedSessionState {
    activeSince?: number;
    activeRunId?: string;
    agent: SessionAgentMetadata;
    agentId: string;
    archived?: boolean;
    archiveOnIdle?: boolean;
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    appendSystemPrompt?: string;
    cwd: string;
    docker?: DockerExecutionConfig;
    draft?: string;
    draftUpdatedAt?: number;
    elapsedMs?: number;
    contextMessages?: readonly Message[];
    effort?: string;
    serviceTier?: ServiceTier;
    id: string;
    instructions?: string;
    goal?: SessionGoal;
    interruption?: SessionInterruption;
    lastMessageAt?: number;
    metadataRunId?: string;
    metadataUpdatedAt?: number;
    messages: readonly PersistedSessionMessage[];
    modelId: string;
    models: readonly Model[];
    orderKey: string;
    providerId: string;
    permissionMode: PermissionMode;
    projectId?: string;
    workspaceId?: string;
    secretIds?: readonly string[];
    queuedRuns: readonly PersistedQueuedRun[];
    recap?: string;
    nextTaskId: number;
    status: SessionStatus;
    tasks: readonly SessionTask[];
    title?: string;
    titleError?: string;
    titleStatus: SessionTitleStatus;
    totalTokens?: number;
    sessionTokenCount?: SessionTokenCount;
    usage?: Usage;
    tools: readonly string[];
    externalToolCalls?: readonly ExternalToolCall[];
    durableUserInputs?: readonly DurableUserInputCall[];
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    systemPrompt?: string;
    workflows?: readonly PersistedWorkflowRun[];
    workflowsEnabled?: boolean;
}

export interface PersistedWorkflowRun {
    agentCalls: readonly (WorkflowAgentCacheEntry | undefined)[];
    checkpoint?: {
        nextAgentCallIndex: number;
        phase: string;
        snapshotBase64: string;
    };
    state: WorkflowRun;
}

export interface InMemorySessionPersistence {
    clearMessages(sessionId: string): void;
    deleteMessagesFrom(sessionId: string, position: number): void;
    deleteQueuedRun(sessionId: string, runId: string): void;
    handoffDurablePermissionToExternalTool?(
        externalCall: ExternalToolCall,
        permissionCall: DurableUserInputCall,
    ): void;
    insertQueuedRun(sessionId: string, run: PersistedQueuedRun): void;
    pruneExternalToolCalls?(sessionId: string, retain: number): void;
    pruneDurableUserInputs?(sessionId: string, retain: number): void;
    saveSession(state: PersistedSessionState): void;
    upsertMessage(sessionId: string, message: PersistedSessionMessage): void;
    upsertExternalToolCall?(call: ExternalToolCall): void;
    upsertDurableUserInput?(call: DurableUserInputCall): void;
}

export interface InMemorySessionOptions {
    agentManager?: AgentSessionManager;
    createEventId: () => EventId;
    createRuntime?: (options: CreateCodingAssistantAgentOptions) => CodingAssistantRuntime;
    emitCreatedEvent?: boolean;
    events?: readonly SessionEvent[];
    initialContextMessages?: readonly Message[];
    id?: string;
    lastEventId?: EventId;
    now?: () => number;
    onInitialTitle?: (metadata: {
        projectId: string;
        sessionId: string;
        title: string;
        workspaceId: string;
    }) => void;
    modelCatalog: ModelCatalog;
    metadata?: SessionAgentMetadata;
    mcpToolProvider?: McpToolProvider;
    onAppendEvent?: (event: SessionEvent) => void;
    orderKey?: string;
    persistence?: InMemorySessionPersistence;
    request: CreateSessionRequest;
    projectSecretIds?: readonly string[];
    projectId?: string;
    secretRegistry?: SecretRegistry;
    restore?: PersistedSessionState;
    taskDrain?: TaskDrain;
    workspaceId?: string;
}

interface ActiveRun {
    controller: AbortController;
    debug: boolean;
    kind: PersistedQueuedRun["kind"];
    runId: string;
}

interface MetadataGenerationTarget {
    kind: "initial" | "refined";
    runId: string;
}

interface ExternalToolWaiter {
    reject: (error: Error) => void;
    resolve: (resolution: ExternalToolCallResolution) => void;
}

interface InternalWorkflowRun {
    agentCalls: (WorkflowAgentCacheEntry | undefined)[];
    checkpoint?: WorkflowCheckpoint;
    completion: Promise<WorkflowRun>;
    controller: AbortController;
    resolveCompletion: (run: WorkflowRun) => void;
    state: WorkflowRun;
}

const MAX_WORKFLOW_LOG_CHARS = 4_000;
const MAX_SUBAGENT_INSPECTION_TEXT_CHARS = 32_000;

interface PendingUserInput {
    durable?: DurableUserInputCall;
    onAbort?: () => void;
    request: UserInputRequest;
    resolve: (response: UserInputResponse) => void;
    signal?: AbortSignal;
}

interface PartialMessageState {
    fallbackId: string;
    position: number | undefined;
    runId: string;
}

interface PendingSteeringMessage {
    message: UserMessage;
    runId: string;
}

interface PendingSteeringContinuation {
    cancelled: boolean;
    ready: Promise<void>;
    resolveReady: () => void;
}

export interface SessionRunCompletion {
    errorMessage?: string;
    status: "aborted" | "completed" | "error";
}

const SUBAGENT_TOKEN_EXHAUSTED_ERROR =
    "The subagent ran out of tokens before returning a response.";

export class InMemorySession {
    #activeSince: number | undefined;
    readonly events: SessionEventLog;
    readonly id: string;

    #appendSystemPrompt: string | undefined;
    #archived = false;
    #activePartial: PartialMessageState | undefined;
    #activeRun: ActiveRun | undefined;
    #abortInFlight:
        | {
              continuePendingSteering: boolean;
              key: string;
              promise: Promise<AbortRunResponse>;
              runId: string | undefined;
          }
        | undefined;
    #agentManager: AgentSessionManager | undefined;
    #agentMetadata: SessionAgentMetadata;
    #agentId: string;
    #createEventId: () => EventId;
    #createRuntime: (options: CreateCodingAssistantAgentOptions) => CodingAssistantRuntime;
    #compactionController: AbortController | undefined;
    #contextMessages: Message[] | undefined;
    #closing = false;
    #compactionActive = false;
    #debugLogs = new Map<string, DebugLog>();
    #draft: string | undefined;
    #draftUpdatedAt: number | undefined;
    #draining: Promise<void> | undefined;
    #elapsedMs = 0;
    #effort: string | undefined;
    #serviceTier: ServiceTier | undefined;
    #goal: SessionGoal | undefined;
    #externalToolCalls = new Map<string, ExternalToolCall>();
    #durableUserInputs = new Map<string, DurableUserInputCall>();
    #resumingDurableToolRun = false;
    #resumeDurableToolRunAgain = false;
    #externalToolDefinitions: readonly ExternalToolDefinition[] = [];
    #durableSkillDefinitions: readonly DurableSkillDefinition[] = [];
    #externalToolInstallation: ExternalToolInstallation = {
        installed: new Set(),
        shadowed: new Map(),
    };
    #externalToolWaiters = new Map<string, ExternalToolWaiter>();
    #instructions: string | undefined;
    #interruption: SessionInterruption | undefined;
    #lastMessageAt: number | undefined;
    #lastSessionRunId: string | undefined;
    #metadataController: AbortController | undefined;
    #metadataInitialAttempted = false;
    #metadataRefinementAttempted = false;
    #metadataRevision = 0;
    #metadataRunId: string | undefined;
    #metadataUpdatedAt: number | undefined;
    #messages: PersistedSessionMessage[] = [];
    #submittedUserMessages = new Map<string, PersistedSessionMessage>();
    #mcpLoaded = false;
    #mcpServers: readonly McpServerSummary[] = [];
    #mcpToolNames = new Set<string>();
    #mcpToolProvider: McpToolProvider | undefined;
    #mcpToolRelease: (() => Promise<void>) | undefined;
    #modelCatalog: ModelCatalog;
    #modelId: string;
    #models: readonly Model[];
    #now: () => number;
    #onInitialTitle: InMemorySessionOptions["onInitialTitle"];
    #orderKey: string;
    #partialPositions = new Set<number>();
    #pendingSteeringMessages = new Map<string, PendingSteeringMessage>();
    #pendingSteeringContinuations = new Map<string, PendingSteeringContinuation>();
    #pendingUserInputs = new Map<string, PendingUserInput>();
    #persistence: InMemorySessionPersistence | undefined;
    #providerId: string;
    #projectId: string;
    #permissionMode: PermissionMode;
    #queue: PersistedQueuedRun[] = [];
    #recap: string | undefined;
    #request: CreateSessionRequest;
    #restoredActiveRunId: string | undefined;
    #runtime: CodingAssistantRuntime | undefined;
    #executor: Executor | undefined;
    #secrets: SessionSecretContext;
    #status: SessionStatus = "idle";
    #unread: SessionUnreadState | undefined;
    #suspendedRunIds = new Set<string>();
    #systemPrompt: string | undefined;
    #workspaceId: string | undefined;
    #suspendOnAbort = false;
    #shutdownCleanup: Promise<void> | undefined;
    #shellCommandCompletions = new Map<number, Promise<void>>();
    #shellHistoryRevision = 0;
    #taskList: SessionTaskList;
    #taskDrain: TaskDrain | undefined;
    #title: string | undefined;
    #titleError: string | undefined;
    #titleStatus: SessionTitleStatus = "idle";
    #totalTokens = 0;
    #sessionTokenCount: SessionTokenCount = { lastContextTokens: 0, totalTokens: 0 };
    #usage: Usage = zeroUsage();
    #tools: readonly string[] = [];
    #workflowRuns = new Map<string, InternalWorkflowRun>();
    #workflowsEnabled: boolean;
    #workspaceArchived = false;

    constructor(options: InMemorySessionOptions) {
        this.#agentManager = options.agentManager;
        this.#createEventId = options.createEventId;
        this.#createRuntime = options.createRuntime ?? createCodingAssistantAgent;
        this.#now = options.now ?? Date.now;
        this.#onInitialTitle = options.onInitialTitle;
        this.#mcpToolProvider = options.mcpToolProvider;
        this.#modelCatalog = options.modelCatalog;
        this.#persistence = options.persistence;
        this.#request = {
            ...options.request,
            archiveOnIdle: options.restore?.archiveOnIdle ?? options.request.archiveOnIdle ?? false,
            trackUnread: options.restore?.trackUnread ?? options.request.trackUnread ?? false,
            ...(options.request.secretIds === undefined
                ? {}
                : { secretIds: [...options.request.secretIds] }),
            ...(options.request.docker === undefined
                ? {}
                : { docker: { ...options.request.docker } }),
        };
        this.#taskDrain = options.taskDrain;
        this.#workflowsEnabled =
            options.restore?.workflowsEnabled ?? options.request.workflowsEnabled ?? true;
        const secretRegistry = options.secretRegistry ?? new SecretRegistry();
        const secretIds = options.restore?.secretIds ?? options.request.secretIds ?? [];
        if (options.restore === undefined) {
            for (const secretId of secretIds) secretRegistry.reference(secretId);
        }
        this.#secrets = new SessionSecretContext(
            secretRegistry,
            secretIds,
            options.projectSecretIds,
        );
        this.id = options.restore?.id ?? options.id ?? createId();
        this.#agentMetadata = options.restore?.agent ??
            options.metadata ?? {
                depth: 0,
                rootSessionId: this.id,
                type: "primary",
            };
        if (this.#request.docker?.image !== undefined && this.#request.docker.name === undefined) {
            this.#request.docker = {
                ...this.#request.docker,
                name: `rig-${this.#agentMetadata.rootSessionId}`,
            };
        }
        this.#agentId = options.restore?.agentId ?? createId();
        this.#archived = options.restore?.archived === true;
        const requestedModelId =
            options.restore?.modelId ??
            options.request.modelId ??
            this.#modelCatalog.defaultModelId;
        const requestedProviderId =
            options.restore?.providerId ??
            options.request.providerId ??
            this.#modelCatalog.defaultProviderId;
        const selection = resolveInitialModelSelection(
            this.#modelCatalog,
            requestedModelId,
            requestedProviderId,
        );
        this.#modelId = selection.model.id;
        this.#providerId = selection.providerId;
        this.#permissionMode = parsePermissionMode(
            options.restore?.permissionMode ??
                options.request.permissionMode ??
                DEFAULT_PERMISSION_MODE,
        );
        this.#projectId = options.restore?.projectId ?? options.projectId ?? createId();
        this.#workspaceId = options.restore?.workspaceId ?? options.workspaceId;
        this.#orderKey =
            options.restore?.orderKey ?? options.orderKey ?? generateKeyBetween(null, null);
        this.#draft = options.restore?.draft;
        this.#draftUpdatedAt = options.restore?.draftUpdatedAt;
        this.#appendSystemPrompt =
            options.restore?.appendSystemPrompt ?? options.request.appendSystemPrompt;
        this.#systemPrompt = options.restore?.systemPrompt;
        this.#externalToolDefinitions = [...(options.restore?.externalTools ?? [])];
        this.#durableSkillDefinitions = [...(options.restore?.skills ?? [])];
        for (const call of options.restore?.externalToolCalls ?? []) {
            this.#externalToolCalls.set(call.id, cloneExternalToolCall(call));
        }
        for (const call of options.restore?.durableUserInputs ?? []) {
            this.#durableUserInputs.set(call.request.requestId, structuredClone(call));
        }
        const requestedEffort = options.restore?.effort ?? options.request.effort;
        this.#effort =
            requestedEffort !== undefined &&
            selection.model.thinkingLevels.includes(requestedEffort)
                ? requestedEffort
                : selection.model.defaultThinkingLevel;
        const requestedServiceTier = options.restore?.serviceTier ?? options.request.serviceTier;
        if (
            requestedServiceTier !== undefined &&
            !this.#providerSupportsServiceTier(selection.providerId, requestedServiceTier)
        ) {
            this.#serviceTier = undefined;
        } else {
            this.#serviceTier = requestedServiceTier;
        }
        this.#instructions = options.restore?.instructions ?? options.request.instructions;
        this.#goal = options.restore?.goal === undefined ? undefined : { ...options.restore.goal };
        this.#contextMessages =
            options.restore?.contextMessages === undefined
                ? options.initialContextMessages === undefined
                    ? undefined
                    : [...options.initialContextMessages]
                : [...options.restore.contextMessages];
        this.#models = this.#modelsForProvider(this.#providerId);
        this.#status = options.restore?.status ?? "idle";
        this.#workspaceArchived = this.#status === "archived";
        this.#unread =
            options.restore?.unread === undefined ? undefined : { ...options.restore.unread };
        this.#activeSince = options.restore?.activeSince;
        this.#elapsedMs = options.restore?.elapsedMs ?? 0;
        this.#lastMessageAt = options.restore?.lastMessageAt;
        this.#metadataRunId = options.restore?.metadataRunId;
        this.#metadataUpdatedAt = options.restore?.metadataUpdatedAt;
        this.#recap = options.restore?.recap;
        this.#restoredActiveRunId = options.restore?.activeRunId;
        this.#lastSessionRunId = options.restore?.activeRunId;
        this.#title = options.restore?.title ?? this.#agentMetadata.description;
        this.#titleError = options.restore?.titleError;
        this.#titleStatus =
            options.restore?.titleStatus ??
            (this.#agentMetadata.description !== undefined ? "ready" : "idle");
        this.#metadataInitialAttempted =
            this.#metadataUpdatedAt !== undefined || this.#titleStatus === "error";
        this.#metadataRefinementAttempted = this.#metadataRunId !== undefined;
        this.#totalTokens = options.restore?.totalTokens ?? 0;
        this.#taskList = new SessionTaskList(options.restore?.tasks, options.restore?.nextTaskId);
        this.#tools = options.restore?.tools ?? [];
        this.#interruption = options.restore?.interruption;
        this.#queue = [...(options.restore?.queuedRuns ?? [])];
        this.#messages = [...(options.restore?.messages ?? [])].sort(
            (left, right) => left.position - right.position,
        );
        this.#usage =
            options.restore?.usage === undefined
                ? this.#sumCommittedUsage()
                : structuredClone(options.restore.usage);
        for (const persisted of options.restore?.workflows ?? []) {
            const state = cloneWorkflowRun(persisted.state);
            if (state.status === "running") {
                state.error = "The workflow was interrupted when the local server stopped.";
                state.finishedAt = this.#now();
                state.status = "stopped";
            }
            let resolveCompletion = (_run: WorkflowRun): void => undefined;
            const completion = new Promise<WorkflowRun>((resolve) => {
                resolveCompletion = resolve;
            });
            const internal: InternalWorkflowRun = {
                agentCalls: [...persisted.agentCalls],
                completion,
                controller: new AbortController(),
                resolveCompletion,
                state,
                ...(persisted.checkpoint === undefined
                    ? {}
                    : {
                          checkpoint: {
                              nextAgentCallIndex: persisted.checkpoint.nextAgentCallIndex,
                              phase: persisted.checkpoint.phase,
                              snapshot: new Uint8Array(
                                  Buffer.from(persisted.checkpoint.snapshotBase64, "base64"),
                              ),
                          },
                      }),
            };
            internal.resolveCompletion(cloneWorkflowRun(state));
            this.#workflowRuns.set(state.runId, internal);
        }
        for (const message of this.#messages) {
            if (message.isPartial) {
                this.#partialPositions.add(message.position);
            }
            if (message.message.role === "user" && message.runId !== undefined) {
                this.#submittedUserMessages.set(message.message.id, message);
            }
        }
        const eventLogOptions: ConstructorParameters<typeof SessionEventLog>[0] = {};
        if (options.events !== undefined) eventLogOptions.events = options.events;
        if (options.lastEventId !== undefined) eventLogOptions.lastEventId = options.lastEventId;
        if (options.onAppendEvent !== undefined) eventLogOptions.onAppend = options.onAppendEvent;
        this.events = new SessionEventLog(eventLogOptions);
        this.#sessionTokenCount = aggregateSessionTokenCount(this.events.since(undefined) ?? []);

        this.#ensureKnownModel(this.#modelId, this.#providerId);
        this.#saveSession();
        if (options.restore === undefined) {
            if (options.emitCreatedEvent !== false) {
                this.emitCreatedEvent();
            }
        } else {
            this.#continueGoalIfIdle();
            if (!this.isSubagent()) this.#restartMetadataSettlement();
        }
    }

    abort(
        options: {
            continuePendingSteering?: boolean;
            expectedRunId?: string;
            stopDescendants?: boolean;
            steeringMessageIds?: readonly string[];
        } = {},
    ): Promise<AbortRunResponse> {
        if (
            options.expectedRunId !== undefined &&
            this.#activeRun?.runId !== options.expectedRunId
        ) {
            return Promise.resolve({ aborted: false });
        }
        const key = createAbortRequestKey(options);
        if (this.#abortInFlight !== undefined) {
            if (this.#abortInFlight.key !== key) {
                if (
                    options.continuePendingSteering !== true &&
                    this.#abortInFlight.continuePendingSteering &&
                    (options.expectedRunId === undefined ||
                        options.expectedRunId === this.#abortInFlight.runId)
                ) {
                    const continuationRunId = this.#abortInFlight.runId;
                    const activeRun = this.#activeRun;
                    if (continuationRunId === undefined || activeRun?.runId !== continuationRunId) {
                        return Promise.resolve({ aborted: false });
                    }
                    const continuation = this.#pendingSteeringContinuations.get(continuationRunId);
                    if (continuation !== undefined) {
                        continuation.cancelled = true;
                        continuation.resolveReady();
                    }
                    activeRun.controller.abort();
                    return this.#abortInFlight.promise.then(
                        ({ continued: _, ...response }) => response,
                    );
                }
                return Promise.reject(
                    new Error("An abort request with different options is already in progress."),
                );
            }
            return this.#abortInFlight.promise;
        }
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        const operation = this.#performAbort(options);
        const tracked = operation.finally(() => {
            if (this.#abortInFlight?.promise === tracked) this.#abortInFlight = undefined;
        });
        this.#abortInFlight = {
            continuePendingSteering: options.continuePendingSteering === true,
            key,
            promise: tracked,
            runId,
        };
        return tracked;
    }

    async #performAbort(options: {
        continuePendingSteering?: boolean;
        expectedRunId?: string;
        stopDescendants?: boolean;
        steeringMessageIds?: readonly string[];
    }): Promise<AbortRunResponse> {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        if (options.expectedRunId !== undefined && runId !== options.expectedRunId) {
            return { aborted: false };
        }
        const continuationMessageIds =
            options.continuePendingSteering === true && runId !== undefined
                ? resolveSteeringContinuationMessageIds({
                      events: this.events.since(undefined) ?? [],
                      pendingMessageIds: new Set(
                          [...this.#pendingSteeringMessages].flatMap(([messageId, pending]) =>
                              pending.runId === runId ? [messageId] : [],
                          ),
                      ),
                      requestedMessageIds: options.steeringMessageIds,
                      runId,
                  })
                : undefined;
        const shouldContinuePendingSteering = continuationMessageIds !== undefined;
        if (
            options.continuePendingSteering === true &&
            runId !== undefined &&
            !shouldContinuePendingSteering
        ) {
            return { aborted: false };
        }
        let continuation: PendingSteeringContinuation | undefined;
        if (shouldContinuePendingSteering && runId !== undefined) {
            continuation = this.#pendingSteeringContinuations.get(runId);
            if (continuation === undefined) {
                let resolveReady = () => {};
                const ready = new Promise<void>((resolve) => {
                    resolveReady = resolve;
                });
                continuation = { cancelled: false, ready, resolveReady };
                this.#pendingSteeringContinuations.set(runId, continuation);
            }
        } else if (runId !== undefined) {
            const pendingContinuation = this.#pendingSteeringContinuations.get(runId);
            if (pendingContinuation !== undefined) {
                pendingContinuation.cancelled = true;
                pendingContinuation.resolveReady();
                this.#pendingSteeringContinuations.delete(runId);
            }
        }
        const stopDescendants =
            options.stopDescendants === false
                ? Promise.resolve(0)
                : (this.#agentManager?.stopDescendants(this.id) ?? Promise.resolve(0));
        const runningProcesses = this.#activeProcessCount();
        if (this.#activeRun === undefined && this.#queue.length === 0 && runningProcesses === 0) {
            if (runId !== undefined && this.hasDurableToolRun()) {
                this.#cancelExternalToolCalls(runId);
                this.#cancelDurableUserInputs(runId);
                this.#restoredActiveRunId = undefined;
                this.#status = "aborted";
                const event = this.#append("abort_requested", { runId });
                await stopDescendants;
                return { aborted: true, eventId: event.id };
            }
            return { aborted: (await stopDescendants) > 0 };
        }

        if (this.#activeRun === undefined && this.#queue.length === 0) {
            const [, stoppedDescendants] = await Promise.all([
                this.#killRuntimeProcesses(),
                stopDescendants,
            ]);
            return {
                aborted: stoppedDescendants > 0,
                stoppedProcesses: runningProcesses,
            };
        }

        const discardedQueue = this.#queue;
        const queuedRunIds = discardedQueue.map((queued) => queued.runId);
        for (const queued of discardedQueue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        this.#queue = [];
        this.#pauseActiveGoal();
        if (runId !== undefined) {
            this.#cancelExternalToolCalls(runId);
            this.#cancelDurableUserInputs(runId);
        }
        this.#activeRun?.controller.abort();
        this.#restoredActiveRunId = undefined;
        const event = this.#append("abort_requested", runId !== undefined ? { runId } : {});
        await Promise.all([
            this.#killRuntimeProcesses(),
            stopDescendants,
            ...discardedQueue.map((queued) => this.#closeDebugLog(queued)),
        ]);
        continuation?.resolveReady();
        for (const queuedRunId of queuedRunIds) {
            this.#append("run_error", {
                errorMessage: "The queued run was stopped.",
                modelLocked: this.#modelLocked(),
                runId: queuedRunId,
            });
        }
        const latestQueuedRunId = queuedRunIds.at(-1);
        if (latestQueuedRunId !== undefined) {
            this.#restartMetadataSettlement();
        }
        return {
            aborted: true,
            ...(shouldContinuePendingSteering && continuation?.cancelled !== true
                ? { continued: true }
                : {}),
            eventId: event.id,
            ...(runningProcesses > 0 ? { stoppedProcesses: runningProcesses } : {}),
        };
    }

    async stopBackgroundProcesses(): Promise<number> {
        const runtime = this.#runtime;
        if (runtime === undefined) return 0;
        const runningProcesses = runtime.context.bash.activeSessionCount?.() ?? 0;
        await runtime.context.bash.killAllSessions?.();
        return runningProcesses;
    }

    async readBackgroundProcess(
        sessionId: number,
        options: { waitMs?: number } = {},
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        const runtime = this.#runtime;
        if (runtime === undefined) return undefined;
        return runtime.context.bash.readSession(sessionId, options);
    }

    async stopBackgroundProcess(sessionId: number): Promise<StopBackgroundProcessResponse> {
        const runtime = this.#runtime;
        if (runtime === undefined) return { stopped: false };
        const process = await runtime.context.bash.killSession(sessionId);
        if (process === undefined) return { stopped: false };
        await this.#shellCommandCompletions.get(sessionId);
        return { process, stopped: true };
    }

    async runShellCommand(request: RunShellCommandRequest): Promise<RunShellCommandResponse> {
        this.#assertAcceptingWork();
        const command = request.command.trim();
        if (command.length === 0) throw new Error("Enter a shell command after !.");

        const historyRevision = this.#shellHistoryRevision;
        const bash = this.#ensureRuntime().context.bash;
        let sessionId: number;
        try {
            sessionId = await bash.startSession({
                command,
                maxOutputBytes: 512_000,
            });
        } catch (error) {
            const result: RunShellCommandResult = {
                command,
                commandId: request.commandId,
                errorMessage: errorToMessage(error),
                exitCode: null,
                output: errorToMessage(error),
                timedOut: false,
            };
            const event = this.#recordShellCommandResult(result, historyRevision);
            return { ...result, eventId: event.id, status: "finished" };
        }

        const event = this.#append("shell_command_started", {
            command,
            commandId: request.commandId,
            sessionId,
        });
        const watch = () =>
            this.#watchShellCommand(bash, command, request.commandId, sessionId, historyRevision);
        const watching = this.#taskDrain?.run(watch) ?? watch();
        const completion = watching
            .catch((error: unknown) => {
                this.#recordShellCommandResult(
                    {
                        command,
                        commandId: request.commandId,
                        errorMessage: errorToMessage(error),
                        exitCode: null,
                        output: errorToMessage(error),
                        sessionId,
                        timedOut: false,
                    },
                    historyRevision,
                );
            })
            .finally(() => {
                if (this.#shellCommandCompletions.get(sessionId) === completion) {
                    this.#shellCommandCompletions.delete(sessionId);
                }
            });
        this.#shellCommandCompletions.set(sessionId, completion);

        return {
            command,
            commandId: request.commandId,
            eventId: event.id,
            sessionId,
            status: "running",
        };
    }

    async #watchShellCommand(
        bash: BashContext,
        command: string,
        commandId: string,
        sessionId: number,
        historyRevision: number,
    ): Promise<void> {
        for (;;) {
            const snapshot = await bash.readSession(sessionId, {
                waitMs: 30_000,
            });
            if (snapshot === undefined) {
                throw new Error("The background terminal is no longer available.");
            }
            if (snapshot.status === "running") continue;

            this.#recordShellCommandResult(
                {
                    command,
                    commandId,
                    exitCode: snapshot.exitCode,
                    output: [snapshot.stdout, snapshot.stderr].filter(Boolean).join("\n"),
                    sessionId,
                    timedOut: snapshot.timedOut,
                },
                historyRevision,
            );
            return;
        }
    }

    #recordShellCommandResult(
        result: RunShellCommandResult,
        historyRevision: number,
    ): ShellCommandFinishedEvent {
        if (historyRevision !== this.#shellHistoryRevision) {
            return this.#append("shell_command_finished", result);
        }
        const contextMessage: UserMessage = {
            blocks: [{ type: "text", text: formatShellCommandContext(result) }],
            id: createId(),
            role: "user",
        };
        const runtime = this.#runtime;
        if (runtime === undefined) {
            this.#separateModelContextFromVisibleTranscript();
            this.#contextMessages?.push(contextMessage);
        } else {
            runtime.agent.enqueueMessage(contextMessage);
        }
        this.#storeMessage(
            this.#messages.length,
            contextMessage,
            false,
            `shell:${result.commandId}`,
        );
        this.#lastMessageAt = this.#now();

        return this.#append("shell_command_finished", result);
    }

    async suspendByParent(): Promise<void> {
        if (!this.isSubagent()) return;
        if (this.#activeRun !== undefined) this.#suspendedRunIds.add(this.#activeRun.runId);
        this.#suspendOnAbort = true;
        await this.abort({ stopDescendants: false });
        this.#status = "suspended";
        if (this.#activeRun === undefined) this.#suspendOnAbort = false;
        this.#saveSession();
    }

    clearSuspension(): void {
        this.#suspendOnAbort = false;
        if (this.#status !== "suspended") return;
        this.#status = "aborted";
        this.#saveSession();
    }

    consumeSuspendedRun(runId: string): boolean {
        return this.#suspendedRunIds.delete(runId);
    }

    recordSubagentsSuspended(subagents: readonly { description: string; path: string }[]): void {
        if (subagents.length === 0) return;
        const count = subagents.length;
        const names = subagents.map((subagent) => subagent.description).join(", ");
        const displayText = `${count} ${count === 1 ? "subagent was" : "subagents were"} suspended: ${names}. They will remain suspended until explicitly resumed or redirected.`;
        this.#ensureRuntime().agent.enqueueMessage({
            blocks: [
                {
                    type: "text",
                    text: [
                        "<subagent-suspension>",
                        "The parent turn was interrupted. These delegated agents were suspended:",
                        ...subagents.map(
                            (subagent) => `- ${subagent.path}: ${subagent.description}`,
                        ),
                        "They will not resume automatically. Use followup_task to continue retained work, or interrupt_agent to leave work stopped.",
                        "</subagent-suspension>",
                    ].join("\n"),
                },
            ],
            id: createId(),
            role: "user",
        });
        this.#append("subagents_suspended", { displayText });
    }

    agentMetadata(): SessionAgentMetadata {
        return { ...this.#agentMetadata };
    }

    usage(): SessionUsageSummary {
        return aggregateSessionUsage(this.events.since(undefined) ?? [], {
            type: this.#agentMetadata.type,
        });
    }

    providerQuota(options?: { fresh?: boolean }): Promise<ProviderQuota | undefined> {
        return this.#ensureRuntime().executor.quota?.(options) ?? Promise.resolve(undefined);
    }

    encryptedAgentTransportScope(): string | undefined {
        const runtime = this.#ensureRuntime();
        return createEncryptedAgentTransportScope(runtime.executor, runtime.agent.model);
    }

    isCodexV2Collaboration(): boolean {
        const providerType = this.#modelCatalog.providers.find(
            (provider) => provider.providerId === this.#providerId,
        )?.providerType;
        return isCodexV2CollaborationModel(this.#modelId, providerType);
    }

    hasModel(modelId: string, providerId?: string): boolean {
        return getProviderIdForModel(this.#modelCatalog, modelId, providerId) !== undefined;
    }

    effortLevelsForModel(modelId: string, providerId: string): readonly string[] | undefined {
        return this.#modelsForProvider(providerId).find((model) => model.id === modelId)
            ?.thinkingLevels;
    }

    providerIdsForModel(modelId: string): readonly string[] {
        return getProviderIdsForModel(this.#modelCatalog, modelId);
    }

    modelIdsForProvider(providerId: string): readonly string[] {
        return this.#modelsForProvider(providerId).map((model) => model.id);
    }

    hasLocalSettlementWork(): boolean {
        return (
            this.#activeRun !== undefined ||
            this.#queue.length > 0 ||
            this.#compactionActive ||
            [...this.#workflowRuns.values()].some((run) => run.state.status === "running") ||
            (this.#runtime?.context.bash.activeSessionCount?.() ?? 0) > 0
        );
    }

    changeModel(request: ChangeModelRequest): ProtocolSession {
        // Resolving the provider before the idle guard keeps an unknown model reported as an
        // unknown model rather than as a busy session.
        this.#resolveProviderForModel(request.modelId, request.providerId);
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error("Wait for the active response to finish before changing models.");
        }
        return this.#applyConfiguration({
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            modelId: request.modelId,
            ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
        });
    }

    changeEffort(request: ChangeEffortRequest): ProtocolSession {
        return this.#applyConfiguration({
            effort: request.effort ?? this.#selectedModel().defaultThinkingLevel,
        });
    }

    changeServiceTier(request: ChangeServiceTierRequest): ProtocolSession {
        return this.#applyConfiguration({ serviceTier: request.serviceTier ?? null });
    }

    /**
     * Applies a model, reasoning effort, or fast mode change and reports it as one event.
     *
     * Every path that changes the agent's configuration goes through here, so a change that moves
     * several fields at once is a single event rather than a burst that readers would have to
     * reassemble. `changed` names only the fields whose values actually moved.
     *
     * `excludeRunId` omits one run's already-stored message from the summarized history an
     * incompatible model switch builds. A message that is about to be sent to the new model must
     * not also be folded into the summary of what the old model saw.
     */
    #applyConfiguration(
        change: {
            effort?: string;
            modelId?: string;
            providerId?: string;
            serviceTier?: ServiceTier | null;
        },
        options: { excludeRunId?: string } = {},
    ): ProtocolSession {
        const changed: SessionConfigurationField[] = [];
        const previousEffort = this.#effort;
        const previousServiceTier = this.#serviceTier;

        // Everything this change asks for is checked against the configuration it would produce
        // before any of it is applied, so a rejected change leaves the session as it was rather
        // than half switched.
        const targetProviderId =
            change.modelId === undefined
                ? this.#providerId
                : this.#resolveProviderForModel(change.modelId, change.providerId);
        const targetModel =
            change.modelId === undefined
                ? this.#selectedModel()
                : this.#ensureKnownModel(change.modelId, targetProviderId);
        if (change.effort !== undefined) {
            this.#assertSupportedEffortForModel(change.effort, targetModel);
        }
        if (
            change.serviceTier !== undefined &&
            change.serviceTier !== null &&
            !this.#providerSupportsServiceTier(targetProviderId, change.serviceTier)
        ) {
            throw new Error(`Provider '${targetProviderId}' does not support fast inference.`);
        }

        if (
            change.modelId !== undefined &&
            (targetModel.id !== this.#modelId || targetProviderId !== this.#providerId)
        ) {
            this.#switchModel(targetModel, targetProviderId, options);
            changed.push("model");
        }

        // An explicit effort always applies. A model switch otherwise resets effort to whatever
        // the new model considers normal, because the old level may not exist on it.
        const effort =
            change.effort ??
            (changed.includes("model") ? this.#selectedModel().defaultThinkingLevel : undefined);
        if (effort !== undefined) {
            this.#assertSupportedEffort(effort);
            this.#effort = effort;
            this.#runtime?.agent.setEffort(effort);
        }

        if (change.serviceTier !== undefined) {
            this.#serviceTier = change.serviceTier ?? undefined;
        } else if (
            this.#serviceTier !== undefined &&
            !this.#providerSupportsServiceTier(this.#providerId, this.#serviceTier)
        ) {
            // Switching to a provider without fast inference silently turns it off, which readers
            // still have to be told about so their view of the session stays true.
            this.#serviceTier = undefined;
        }
        this.#runtime?.agent.setServiceTier(this.#serviceTier);

        if (this.#effort !== previousEffort) changed.push("effort");
        if (this.#serviceTier !== previousServiceTier) changed.push("serviceTier");

        this.#interruption = undefined;
        this.#append("session_configuration_changed", {
            changed,
            ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            modelId: this.#modelId,
            serviceTier: this.#serviceTier ?? null,
            snapshot: this.#agentSnapshot(),
        });
        return this.snapshot();
    }

    #resolveProviderForModel(modelId: string, providerId?: string): string {
        const resolved =
            (providerId !== undefined
                ? getProviderIdForModel(this.#modelCatalog, modelId, providerId)
                : getProviderIdForModel(this.#modelCatalog, modelId, this.#providerId)) ??
            (providerId === undefined
                ? getProviderIdForModel(this.#modelCatalog, modelId)
                : undefined);
        if (resolved === undefined) {
            const providerDescription =
                providerId !== undefined ? ` for provider '${providerId}'` : "";
            throw new Error(`Unknown model '${modelId}'${providerDescription}.`);
        }
        return resolved;
    }

    #switchModel(model: Model, providerId: string, options: { excludeRunId?: string }): void {
        const previousModel = this.#selectedModel();
        const compatible = areProviderModelsCompatible(
            {
                modelId: previousModel.id,
                providerId: this.#providerId,
                providerType:
                    this.#modelCatalog.providers.find(
                        (provider) => provider.providerId === this.#providerId,
                    )?.providerType ?? "gym",
            },
            {
                modelId: model.id,
                providerId,
                providerType:
                    this.#modelCatalog.providers.find(
                        (provider) => provider.providerId === providerId,
                    )?.providerType ?? "gym",
            },
        );
        if (compatible) {
            this.#syncContextMessages();
        } else {
            // A message already stored for a run that has not reached the model yet belongs to
            // the new model, not to the summary of what the old one saw.
            const visibleMessages = this.#committedMessagesExcludingRun(options.excludeRunId);
            this.#contextMessages =
                visibleMessages.length === 0
                    ? // Undefined means "the context is the visible transcript", which would put
                      // the excluded message back and send it to the model twice. When a message
                      // was excluded, an empty context is what is actually true.
                      options.excludeRunId === undefined
                        ? undefined
                        : []
                    : [
                          createModelSwitchHistoryMessage({
                              canReadAgentHistory: this.#agentManager !== undefined,
                              fromModel: previousModel,
                              fromProviderId: this.#providerId,
                              id: createId(),
                              messages: visibleMessages,
                              subagentCount: this.#agentManager?.list(this.id).length ?? 0,
                              toModel: model,
                              toProviderId: providerId,
                          }),
                      ];
        }
        const runtime = this.#runtime;
        const reusableExecutor =
            runtime?.executor instanceof Executor ? runtime.executor : undefined;
        if (compatible && reusableExecutor !== undefined) {
            reusableExecutor.selectProvider(providerId);
            // Effort is settled by the caller once the new model is known, so it is not guessed
            // here; the agent falls back to the new model's default until then.
            runtime!.agent.setModel(model.id, undefined);
        } else {
            void this.#killRuntimeProcesses();
            this.#releaseMcpToolLease();
            if (reusableExecutor === undefined) {
                void runtime?.agent.close();
                this.#executor = undefined;
            } else {
                this.#executor = reusableExecutor;
                void reusableExecutor.reset({ modelId: model.id, providerId });
            }
            this.#runtime = undefined;
            this.#mcpLoaded = false;
            this.#mcpServers = [];
            this.#mcpToolNames.clear();
            this.#tools = [];
        }
        this.#modelId = model.id;
        this.#providerId = providerId;
        this.#models = this.#modelsForProvider(providerId);
    }

    createForkState(): PersistedSessionState {
        this.#assertAcceptingWork();
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be forked.");
        }
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error("Wait for the active response to finish before forking this session.");
        }

        this.#syncContextMessages();
        const state = this.state();
        const id = createId();
        const {
            activeRunId: _activeRunId,
            archived: _archived,
            goal: _goal,
            interruption: _interruption,
            title: _title,
            titleError: _titleError,
            metadataRunId: _metadataRunId,
            metadataUpdatedAt: _metadataUpdatedAt,
            recap: _recap,
            workflows: _workflows,
            ...rest
        } = state;
        const title = state.title === undefined ? undefined : `${state.title} (fork)`;
        return {
            ...rest,
            agent: { depth: 0, rootSessionId: id, type: "primary" },
            agentId: createId(),
            archived: false,
            id,
            lastMessageAt: this.#now(),
            messages: state.messages.map((message) => ({ ...message })),
            nextTaskId: 1,
            queuedRuns: [],
            secretIds: [],
            status: "idle",
            tasks: [],
            titleStatus: title === undefined ? "idle" : "ready",
            tools: [],
            workflows: [],
            ...(title !== undefined ? { title } : {}),
        };
    }

    update(request: UpdateSessionRequest): ProtocolSession {
        this.#appendSystemPrompt = request.appendSystemPrompt ?? undefined;
        this.#runtime?.agent.setAppendSystemPrompt(this.#appendSystemPrompt);
        this.#interruption = undefined;
        this.#append("session_updated", { session: this.snapshot() });
        return this.snapshot();
    }

    setOrderKey(orderKey: string): ProtocolSession {
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be reordered.");
        }
        if (this.#orderKey === orderKey) return this.snapshot();
        this.#orderKey = orderKey;
        this.#append("session_updated", { session: this.snapshot() });
        return this.snapshot();
    }

    /**
     * Store the composer draft and mirror it to every other attached client.
     * The draft belongs to the clients: Rig keeps the latest text so a restarted
     * terminal or a newly attached client can pick the message back up, and does
     * not otherwise interpret it.
     */
    setDraft(request: SetSessionDraftRequest): ProtocolSession {
        const draft =
            request.draft === null || request.draft.length === 0 ? undefined : request.draft;
        if (draft !== undefined && draft.length > SESSION_DRAFT_MAX_LENGTH) {
            throw new Error("The draft is too long to sync.");
        }
        const updatedAt = clampSessionDraftTimestamp(request.updatedAt, this.#now());
        // The newest message wins, not the last one to arrive. A draft typed
        // before the one already stored is discarded even when a slow client
        // delivers it afterwards.
        if (this.#draftUpdatedAt !== undefined && updatedAt < this.#draftUpdatedAt) {
            return this.snapshot();
        }
        if (this.#draft === draft) return this.snapshot();
        this.#draft = draft;
        this.#draftUpdatedAt = updatedAt;
        this.#append("session_draft_changed", {
            ...(draft === undefined ? {} : { draft }),
            ...(request.origin === undefined ? {} : { origin: request.origin }),
            updatedAt,
        });
        return this.snapshot();
    }

    /**
     * Project and workspace identity without building a protocol snapshot. Observers on hot paths
     * need only these two fields, and `snapshot()` walks every message to produce them.
     */
    projectIdentity(): { projectId: string; workspaceId?: string } {
        return {
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
        };
    }

    setArchived(archived: boolean): ProtocolSession {
        if (!archived && this.#workspaceArchived) {
            throw new Error("A session archived with its workspace cannot be restored.");
        }
        if (this.#archived === archived) return this.snapshot();
        this.#archived = archived;
        this.#append("session_archived", { archived });
        return this.snapshot();
    }

    async changePermissionMode(
        request: ChangePermissionModeRequest,
        options: { updateSubagents?: boolean } = {},
    ): Promise<ProtocolSession> {
        const permissionMode = parsePermissionMode(request.permissionMode);
        if (!this.isSubagent() && options.updateSubagents !== false) {
            await this.#agentManager?.changeSubagentPermissionModes(this.id, permissionMode);
        }
        const runtime = this.#runtime;
        const running = this.#activeProcessCount();
        if (running > 0 && isPermissionReduction(this.#permissionMode, permissionMode)) {
            await this.#killRuntimeProcesses();
            const runId = this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background";
            this.#append("agent_event", {
                event: { type: "background_processes_stopped", count: running },
                runId,
            });
        }
        const permissionChanged = this.#permissionMode !== permissionMode;
        this.#permissionMode = permissionMode;
        runtime?.context.permissions?.setMode(permissionMode);
        if (permissionChanged) {
            this.#removeMcpTools(runtime);
        }
        this.#append("permission_mode_changed", { permissionMode });
        if (
            permissionChanged &&
            runtime !== undefined &&
            permissionMode !== "auto" &&
            permissionMode !== "full_access"
        ) {
            await this.#ensureMcpTools(runtime);
        }
        return this.snapshot();
    }

    attachSecret(
        secretId: string,
        options: { scope?: SecretAttachmentScope } = {},
    ): ProtocolSession {
        const scope = options.scope ?? "session";
        this.#secrets.attach(secretId, scope);
        this.#append("secrets_changed", this.#secretAttachmentData());
        return this.snapshot();
    }

    detachSecret(
        secretId: string,
        options: { scope?: SecretAttachmentScope } = {},
    ): ProtocolSession {
        const scope = options.scope ?? "session";
        if (!this.#secrets.detach(secretId, scope)) return this.snapshot();
        this.#append("secrets_changed", this.#secretAttachmentData());
        return this.snapshot();
    }

    setGoal(request: CreateGoalRequest): SessionGoal {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal !== undefined && this.#goal.status !== "complete") {
            throw new Error(
                "This session already has an unfinished goal. Complete or clear it before starting another.",
            );
        }

        const now = this.#now();
        this.#goal = {
            createdAt: now,
            objective: normalizeGoalObjective(request.objective),
            status: "active",
            updatedAt: now,
        };
        this.#lastMessageAt = now;
        this.#append("goal_changed", { goal: { ...this.#goal } });
        if (this.#titleStatus === "idle") {
            this.#title = createGoalTitle(this.#goal.objective);
            this.#titleStatus = "ready";
            this.#append("session_title_changed", {
                status: this.#titleStatus,
                title: this.#title,
            });
        }
        this.#continueGoalIfIdle();
        return { ...this.#goal };
    }

    changeGoalStatus(
        request: ChangeGoalStatusRequest,
        options: { stopActiveGoalRun?: boolean } = {},
    ): SessionGoal {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal === undefined) {
            throw new Error("This session does not have a goal.");
        }
        if (request.status === "active" && this.#goal.status === "complete") {
            throw new Error("A completed goal cannot be resumed. Start a new goal instead.");
        }

        this.#goal = { ...this.#goal, status: request.status, updatedAt: this.#now() };
        this.#append("goal_changed", { goal: { ...this.#goal } });
        if (request.status === "active") {
            this.#continueGoalIfIdle();
        } else if (options.stopActiveGoalRun !== false) {
            void this.#agentManager?.pauseDescendants(this.id);
            this.#discardQueuedGoalRuns();
            if (this.#activeRun?.kind === "goal") {
                this.#activeRun.controller.abort();
                void this.#killRuntimeProcesses();
            }
        }
        return { ...this.#goal };
    }

    clearGoal(): boolean {
        if (this.isSubagent()) {
            throw new Error("Goals can only be managed from the primary session.");
        }
        if (this.#goal === undefined) return false;

        this.#goal = undefined;
        void this.#agentManager?.stopDescendants(this.id);
        this.#discardQueuedGoalRuns();
        if (this.#activeRun?.kind === "goal") {
            this.#activeRun.controller.abort();
            void this.#killRuntimeProcesses();
        }
        this.#append("goal_changed", { goal: null });
        return true;
    }

    goal(): SessionGoal | undefined {
        return this.#goal === undefined ? undefined : { ...this.#goal };
    }

    requestUserInput(
        request: UserInputRequest,
        options: { durable?: DurableUserInputOptions; signal?: AbortSignal } = {},
    ): Promise<UserInputResponse> {
        if (this.isSubagent()) {
            throw new Error("Only the primary session can ask the user a question.");
        }
        if (this.#pendingUserInputs.has(request.requestId)) {
            throw new Error("A user input request with this identifier is already pending.");
        }
        if (isSignalAborted(options.signal)) {
            return Promise.reject(new Error("The user input request was cancelled."));
        }

        let durable: DurableUserInputCall | undefined;
        let createdDurable = false;
        if (options.durable !== undefined) {
            const runId = this.#activeRun?.runId;
            if (runId === undefined) {
                throw new Error("Durable interactive user input requires an active run.");
            }
            const existing = this.#durableUserInputs.get(request.requestId);
            if (existing !== undefined) {
                if (
                    existing.runId !== runId ||
                    existing.batchId !== options.durable.batchId ||
                    existing.toolCallId !== options.durable.toolCallId
                ) {
                    throw new Error(
                        "The durable user input identity does not match its pending request.",
                    );
                }
                if (existing.response !== undefined) {
                    return Promise.resolve(structuredClone(existing.response));
                }
                durable = existing;
            } else {
                durable = {
                    batchId: options.durable.batchId,
                    consumed: false,
                    createdAt: this.#now(),
                    kind: options.durable.kind,
                    ...(options.durable.permission === undefined
                        ? {}
                        : { permission: { ...options.durable.permission } }),
                    ...(options.durable.providerToolCallId === undefined
                        ? {}
                        : { providerToolCallId: options.durable.providerToolCallId }),
                    request: structuredClone(request),
                    runId,
                    sessionId: this.id,
                    status: "pending",
                    toolArguments: structuredClone(options.durable.toolArguments),
                    toolCallId: options.durable.toolCallId,
                    toolCallIndex: options.durable.toolCallIndex,
                    toolName: options.durable.toolName,
                };
                this.#durableUserInputs.set(request.requestId, durable);
                this.#persistence?.upsertDurableUserInput?.(durable);
                createdDurable = true;
            }
        }

        const response = new Promise<UserInputResponse>((resolve, reject) => {
            const pending: PendingUserInput = {
                request,
                resolve,
                ...(durable === undefined ? {} : { durable }),
            };
            if (options.signal !== undefined) pending.signal = options.signal;
            const onAbort = () => {
                if (this.#pendingUserInputs.get(request.requestId) !== pending) return;
                this.#pendingUserInputs.delete(request.requestId);
                if (pending.durable === undefined) {
                    this.#append("user_input_resolved", {
                        requestId: request.requestId,
                        status: "cancelled",
                    });
                } else if (!this.#closing && pending.durable.status === "pending") {
                    this.#cancelDurableUserInput(pending.durable);
                }
                reject(new Error("The user input request was cancelled."));
            };
            pending.onAbort = onAbort;
            options.signal?.addEventListener("abort", onAbort, { once: true });
            this.#pendingUserInputs.set(request.requestId, pending);
        });
        if (durable === undefined || createdDurable) {
            this.#append("user_input_requested", request);
        }
        if (isSignalAborted(options.signal)) {
            this.#pendingUserInputs.get(request.requestId)?.onAbort?.();
        }
        return response;
    }

    answerUserInput(requestId: string, response: UserInputResponse): ProtocolSession | undefined {
        const pending = this.#pendingUserInputs.get(requestId);
        const durable = this.#durableUserInputs.get(requestId);
        if (pending === undefined && durable === undefined) return undefined;

        if (durable?.response !== undefined) {
            if (!isDeepStrictEqual(durable.response, response)) {
                throw new Error("This question already has a different answer.");
            }
            return this.snapshot();
        }

        const request = pending?.request ?? durable?.request;
        if (request === undefined) return undefined;

        const responseAnswers = (response as { answers?: unknown } | null)?.answers;
        if (
            responseAnswers === null ||
            typeof responseAnswers !== "object" ||
            Array.isArray(responseAnswers)
        ) {
            throw new Error("Choose an answer for every question before continuing.");
        }

        const answers: Record<string, readonly string[]> = {};
        for (const question of request.questions) {
            const selected = (responseAnswers as Record<string, unknown>)[question.id];
            if (
                question.required === false &&
                (selected === undefined || (Array.isArray(selected) && selected.length === 0))
            ) {
                continue;
            }
            if (
                !Array.isArray(selected) ||
                selected.length === 0 ||
                selected.some((answer) => typeof answer !== "string" || answer.trim() === "")
            ) {
                throw new Error(`Answer the ${question.header} question before continuing.`);
            }
            if (!question.multiSelect && selected.length > 1) {
                throw new Error(`Choose one answer for the ${question.header} question.`);
            }
            answers[question.id] = [...selected];
        }

        if (pending !== undefined) {
            this.#pendingUserInputs.delete(requestId);
            if (pending.onAbort !== undefined) {
                pending.signal?.removeEventListener("abort", pending.onAbort);
            }
        }
        const normalizedResponse = { answers };
        if (durable !== undefined) {
            durable.response = structuredClone(normalizedResponse);
            durable.resolvedAt = this.#now();
            durable.status = "answered";
            this.#persistence?.upsertDurableUserInput?.(durable);
        }
        this.#append("user_input_resolved", {
            answers,
            requestId,
            status: "answered",
        });
        if (pending !== undefined) {
            pending.resolve(normalizedResponse);
        } else if (durable !== undefined) {
            this.resumeDurableToolRun();
        }
        return this.snapshot();
    }

    markUserInputExecuting(requestId: string): void {
        const durable = this.#durableUserInputs.get(requestId);
        if (durable === undefined || durable.status !== "answered") return;
        durable.status = "executing";
        this.#persistence?.upsertDurableUserInput?.(durable);
    }

    createTask(request: CreateTaskRequest): SessionTask {
        const task = this.#taskList.create(request);
        this.#recordTasksChanged();
        return task;
    }

    getTask(taskId: string): SessionTask | undefined {
        return this.#taskList.get(taskId);
    }

    listTasks(): readonly SessionTask[] {
        return this.#taskList.list();
    }

    updateTask(taskId: string, request: UpdateTaskRequest): UpdateTaskResult {
        const result = this.#taskList.update(taskId, request);
        if (result.success && result.updatedFields.length > 0) this.#recordTasksChanged();
        return result;
    }

    getWorkflow(runId: string): WorkflowRun | undefined {
        const run = this.#workflowRuns.get(runId)?.state;
        return run === undefined ? undefined : cloneWorkflowRun(run);
    }

    listWorkflows(): readonly WorkflowRun[] {
        return [...this.#workflowRuns.values()]
            .map((run) => cloneWorkflowRun(run.state))
            .sort((left, right) => right.startedAt - left.startedAt);
    }

    async waitForWorkflow(runId: string, signal?: AbortSignal): Promise<WorkflowRun | undefined> {
        const internal = this.#workflowRuns.get(runId);
        if (internal === undefined) return undefined;
        if (internal.state.status !== "running") return cloneWorkflowRun(internal.state);
        if (signal?.aborted === true) throw new Error("Waiting for the workflow was cancelled.");

        return await new Promise<WorkflowRun>((resolve, reject) => {
            let settled = false;
            const finish = (run: WorkflowRun) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", abort);
                resolve(run);
            };
            const abort = () => {
                if (settled) return;
                settled = true;
                reject(new Error("Waiting for the workflow was cancelled."));
            };
            signal?.addEventListener("abort", abort, { once: true });
            void internal.completion.then(finish);
        });
    }

    launchWorkflow(request: LaunchWorkflowRequest): WorkflowRun {
        this.#assertAcceptingWork();
        if (!this.#workflowsEnabled) {
            throw new Error("Workflows are disabled for this session.");
        }
        const resumed =
            request.resumeFromRunId === undefined
                ? undefined
                : this.#workflowRuns.get(request.resumeFromRunId);
        if (request.resumeFromRunId !== undefined && resumed === undefined) {
            throw new Error("The workflow run to resume was not found in this session.");
        }
        if (resumed?.state.status === "running") {
            throw new Error("Stop the previous workflow run before resuming it.");
        }
        const resumeCheckpoint =
            resumed?.state.code === request.code ? resumed.checkpoint : undefined;

        const runId = createId();
        const controller = new AbortController();
        let resolveCompletion = (_run: WorkflowRun): void => undefined;
        const completion = new Promise<WorkflowRun>((resolve) => {
            resolveCompletion = resolve;
        });
        const state: WorkflowRun = {
            agentCount: 0,
            code: request.code,
            description: request.description,
            logs: [],
            name: request.name,
            runId,
            startedAt: this.#now(),
            status: "running",
            taskId: `workflow:${runId}`,
        };
        const internal: InternalWorkflowRun = {
            agentCalls: [],
            completion,
            controller,
            resolveCompletion,
            state,
        };
        this.#workflowRuns.set(runId, internal);
        this.#recordWorkflowUpdate({
            agentCount: state.agentCount,
            code: request.code,
            description: state.description,
            name: state.name,
            runId,
            startedAt: state.startedAt,
            status: state.status,
            taskId: state.taskId,
        });
        const execute = () =>
            request
                .execute({
                    onAgentCall: () => {
                        state.agentCount += 1;
                        this.#recordWorkflowUpdate({ agentCount: state.agentCount, runId });
                    },
                    onAgentResult: (index, result) => {
                        internal.agentCalls[index] = result;
                        this.#saveSession();
                    },
                    onCheckpoint: (checkpoint) => {
                        internal.checkpoint = checkpoint;
                        this.#saveSession();
                    },
                    onLog: (message) => {
                        const trimmed = message.trim();
                        if (trimmed.length === 0) return;
                        const logs = state.logs as string[];
                        logs.push(
                            trimmed.length <= MAX_WORKFLOW_LOG_CHARS
                                ? trimmed
                                : `${trimmed.slice(0, MAX_WORKFLOW_LOG_CHARS)}…`,
                        );
                        if (logs.length > 200) logs.shift();
                        const log = logs.at(-1);
                        const phase = /^Phase:\s*(.+)$/u.exec(log ?? "")?.[1]?.trim();
                        if (phase !== undefined && phase.length > 0) state.phase = phase;
                        if (log !== undefined) {
                            this.#recordWorkflowUpdate({
                                log,
                                ...(state.phase === undefined ? {} : { phase: state.phase }),
                                runId,
                            });
                        }
                    },
                    resumeAgentCalls: resumed?.agentCalls ?? [],
                    ...(resumeCheckpoint === undefined ? {} : { resumeCheckpoint }),
                    runId,
                    signal: controller.signal,
                })
                .then((result) => {
                    if (this.#workflowRuns.get(runId) !== internal) return;
                    internal.agentCalls = [...result.agentCalls];
                    state.output = result.output;
                    state.finishedAt = this.#now();
                    state.status = "completed";
                    this.#recordWorkflowUpdate({
                        finishedAt: state.finishedAt,
                        output: state.output,
                        runId,
                        status: state.status,
                    });
                })
                .catch((error: unknown) => {
                    if (this.#workflowRuns.get(runId) !== internal) return;
                    if (state.status !== "stopped") {
                        state.error = errorToMessage(error);
                        state.finishedAt = this.#now();
                        state.status = "error";
                        this.#recordWorkflowUpdate({
                            error: state.error,
                            finishedAt: state.finishedAt,
                            runId,
                            status: state.status,
                        });
                    }
                })
                .finally(() => {
                    if (this.#workflowRuns.get(runId) !== internal) return;
                    internal.resolveCompletion(cloneWorkflowRun(state));
                    if (this.#closing) return;
                    const statusText =
                        state.status === "completed"
                            ? "completed"
                            : state.status === "stopped"
                              ? "was stopped"
                              : "failed";
                    const resultText =
                        state.status === "completed"
                            ? serializeWorkflowValue(state.output)
                            : (state.error ?? "The workflow did not return a result.");
                    this.deliverNotification({
                        displayText: `Workflow ${humanizeWorkflowName(state.name)} ${statusText}.`,
                        text: [
                            "<workflow-notification>",
                            `Workflow: ${state.name}`,
                            `Run ID: ${state.runId}`,
                            `Status: ${state.status}`,
                            `Agents: ${state.agentCount}`,
                            `Result: ${resultText}`,
                            ...(state.logs.length === 0
                                ? []
                                : ["Progress:", ...state.logs.map((log) => `- ${log}`)]),
                            "</workflow-notification>",
                        ].join("\n"),
                    });
                });
        const execution = this.#taskDrain?.run(execute) ?? execute();
        void execution.catch(() => undefined);
        return cloneWorkflowRun(state);
    }

    stopWorkflow(runId: string): WorkflowRun | undefined {
        const run = this.#workflowRuns.get(runId);
        if (run === undefined) return undefined;
        if (run.state.status === "running") {
            run.state.status = "stopped";
            run.state.error = "The workflow was stopped.";
            run.state.finishedAt = this.#now();
            run.controller.abort();
            this.#recordWorkflowUpdate({
                error: run.state.error,
                finishedAt: run.state.finishedAt,
                runId,
                status: run.state.status,
            });
        }
        return cloneWorkflowRun(run.state);
    }

    emitCreatedEvent(): void {
        this.#append("session_created", { session: this.snapshot() });
    }

    beginShutdown(): Promise<void> {
        if (this.#shutdownCleanup !== undefined) return this.#shutdownCleanup;
        this.#closing = true;
        this.#releaseMcpToolLease();
        this.#clearMetadataSettlement();
        for (const workflow of this.#workflowRuns.values()) {
            if (workflow.state.status === "running") this.stopWorkflow(workflow.state.runId);
        }
        const activeRun = this.#activeRun;
        if (activeRun !== undefined && this.hasDurableToolRun() && !this.#workspaceArchived) {
            this.#restoredActiveRunId = activeRun.runId;
            this.#activeRun = undefined;
            this.#status = "running";
        }
        activeRun?.controller.abort();
        this.#compactionController?.abort();
        this.#shutdownCleanup = Promise.all([
            this.#killRuntimeProcesses(5_000),
            this.#runtime?.agent.close() ?? Promise.resolve(),
        ]).then(() => undefined);
        return this.#shutdownCleanup;
    }

    archiveForWorkspace(workspaceId: string): Promise<void> {
        if (this.#workspaceArchived) return this.#shutdownCleanup ?? Promise.resolve();
        const activeRun = this.#activeRun;
        const runIds = new Set([
            ...(activeRun === undefined ? [] : [activeRun.runId]),
            ...(this.#restoredActiveRunId === undefined ? [] : [this.#restoredActiveRunId]),
            ...this.#queue.map((run) => run.runId),
        ]);
        for (const runId of runIds) {
            this.#cancelExternalToolCalls(runId);
            this.#cancelDurableUserInputs(runId);
        }
        for (const run of this.#queue) this.#persistence?.deleteQueuedRun(this.id, run.runId);
        this.#queue = [];
        this.#finishElapsedInterval();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#pendingSteeringContinuations.clear();
        this.#suspendedRunIds.clear();
        this.#suspendOnAbort = false;
        this.#pauseActiveGoal();
        activeRun?.controller.abort();
        this.#status = "archived";
        this.#archived = true;
        this.#append("session_workspace_archived", {
            reason: "workspace_archived",
            workspaceId,
        });
        this.#workspaceArchived = true;
        return this.beginShutdown();
    }

    isClosing(): boolean {
        return this.#closing;
    }

    markInterrupted(interruption: SessionInterruption): void {
        this.#finishElapsedInterval();
        this.#interruption = interruption;
        this.#status = "error";
        this.#activeRun?.controller.abort();
        if (!this.#closing) void this.#killRuntimeProcesses();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#suspendedRunIds.clear();
        this.#pauseActiveGoal();
        const interruptedRunIds = [
            ...(interruption.runId !== undefined ? [interruption.runId] : []),
            ...this.#queue.map((queued) => queued.runId),
        ];
        const discardedQueue = this.#queue;
        for (const queued of discardedQueue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        this.#queue = [];
        void Promise.all(discardedQueue.map((queued) => this.#closeDebugLog(queued)));
        if (interruptedRunIds.length > 0) {
            for (const runId of new Set(interruptedRunIds)) {
                this.#append("run_error", {
                    errorMessage: interruption.message,
                    modelLocked: this.#modelLocked(),
                    runId,
                    startupInterruption: true,
                });
            }
            this.#restartMetadataSettlement();
            this.#saveSession();
            return;
        }

        this.#saveSession();
    }

    markSuspendedAfterRestart(message: string, runId?: string): void {
        if (!this.isSubagent() || this.#status !== "suspended") {
            throw new Error("Only a suspended subagent can be repaired as resumable.");
        }
        this.#finishElapsedInterval();
        this.#activeRun?.controller.abort();
        this.#activeRun = undefined;
        this.#restoredActiveRunId = undefined;
        this.#activePartial = undefined;
        this.#suspendOnAbort = false;
        for (const queued of this.#queue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        this.#queue = [];
        if (runId !== undefined) {
            this.#append("run_error", {
                errorMessage: message,
                modelLocked: this.#modelLocked(),
                runId,
                startupInterruption: true,
            });
        }
        this.#status = "suspended";
        this.#saveSession();
    }

    recordSubagentStoppedAfterRestart(subagent: SubagentSummary): void {
        const taskName = subagent.taskName ?? subagent.id;
        const runId = `restart:${subagent.id}`;
        const displayText = `Background work "${subagent.description}" stopped when the local server restarted.`;
        const message: UserMessage = {
            blocks: [
                {
                    type: "text",
                    text: [
                        "<subagent-notification>",
                        `Task: ${taskName}`,
                        "Status: suspended",
                        "Result: The subagent stopped working when the local server restarted. It remains suspended and will not resume automatically.",
                        `Use followup_task with target ${JSON.stringify(taskName)} to continue it, or interrupt_agent to leave it stopped.`,
                        "</subagent-notification>",
                    ].join("\n"),
                },
            ],
            id: createId(),
            role: "user",
        };
        this.#separateModelContextFromVisibleTranscript();
        this.#storeMessage(this.#messages.length, message, false, runId);
        this.#contextMessages?.push(message);
        this.#lastMessageAt = this.#now();
        this.#append("message_submitted", {
            displayText,
            message,
            runId,
            source: "notification",
        });
        this.#saveSession();
    }

    async reset(): Promise<ProtocolSession> {
        this.#shellHistoryRevision += 1;
        this.#clearMetadataSettlement();
        this.#invalidateSessionMetadata();
        await this.#agentManager?.stopDescendants(this.id);
        const activeRunId = this.#activeRun?.runId;
        await this.abort({ stopDescendants: false });
        await Promise.allSettled(this.#shellCommandCompletions.values());
        if (activeRunId !== undefined) await this.waitForRun(activeRunId);
        await this.#draining?.catch(() => undefined);
        const workflowRuns = [...this.#workflowRuns.values()];
        for (const run of workflowRuns) {
            if (run.state.status === "running") this.stopWorkflow(run.state.runId);
        }
        await Promise.all(workflowRuns.map((run) => run.completion));
        this.#workflowRuns.clear();
        await this.#ensureRuntime().agent.reset();
        this.#status = "idle";
        this.#interruption = undefined;
        this.#restoredActiveRunId = undefined;
        this.#lastSessionRunId = undefined;
        this.#messages = [];
        this.#usage = zeroUsage();
        this.#submittedUserMessages.clear();
        this.#contextMessages = undefined;
        this.#partialPositions.clear();
        this.#activePartial = undefined;
        this.#pendingSteeringMessages.clear();
        this.#suspendedRunIds.clear();
        const hadTasks = this.#taskList.reset();
        const hadGoal = this.#goal !== undefined;
        this.#goal = undefined;
        this.#persistence?.clearMessages(this.id);
        if (hadTasks) this.#recordTasksChanged();
        if (hadGoal) this.#append("goal_changed", { goal: null });
        this.#append("session_reset", { snapshot: this.#agentSnapshot() });
        return this.snapshot();
    }

    rewind(messageId: string): RewindSessionResponse {
        if (this.isSubagent()) {
            throw new Error("Subagent histories cannot be rewound.");
        }
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error(
                "Wait for the active response to finish before rewinding this session.",
            );
        }

        const target = this.#messages.find(
            (entry) => !entry.isPartial && entry.message.id === messageId,
        );
        if (target === undefined || target.message.role !== "user") {
            throw new Error("The selected user message is no longer available.");
        }

        this.#shellHistoryRevision += 1;
        void this.#killRuntimeProcesses();
        this.#releaseMcpToolLease();
        void this.#runtime?.agent.close();
        this.#runtime = undefined;
        this.#mcpLoaded = false;
        this.#mcpServers = [];
        this.#mcpToolNames.clear();
        this.#tools = [];
        this.#messages = this.#messages.filter((entry) => entry.position < target.position);
        this.#submittedUserMessages = new Map(
            this.#messages.flatMap((entry) =>
                entry.message.role === "user" && entry.runId !== undefined
                    ? [[entry.message.id, entry] as const]
                    : [],
            ),
        );
        this.#invalidateSessionMetadata();
        this.#contextMessages = undefined;
        this.#partialPositions = new Set(
            [...this.#partialPositions].filter((position) => position < target.position),
        );
        this.#activePartial = undefined;
        this.#interruption = undefined;
        this.#lastSessionRunId = undefined;
        this.#restoredActiveRunId = undefined;
        this.#status = "idle";
        this.#lastMessageAt = this.#now();
        this.#persistence?.deleteMessagesFrom(this.id, target.position);
        this.#append("session_rewound", {
            messageId,
            snapshot: this.#agentSnapshot(),
        });
        this.#restartMetadataSettlement();
        return { message: target.message, session: this.snapshot() };
    }

    async compact(signal?: AbortSignal): Promise<AgentCompactionResult> {
        this.#assertAcceptingWork();
        if (this.#activeRun !== undefined || this.#queue.length > 0) {
            throw new Error("Wait for the active response to finish before compacting.");
        }

        const controller = new AbortController();
        this.#compactionController = controller;
        const compactSignal =
            signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
        const previousStatus = this.#status;
        const compactionRunId = `compaction:${createId()}`;
        this.#compactionActive = true;
        this.#status = "running";
        this.#restartMetadataSettlement();
        this.#saveSession();
        try {
            const result = await this.#ensureRuntime().agent.compact(compactSignal, (event) =>
                this.#appendCompactionAgentEvent(compactionRunId, event),
            );
            this.#syncContextMessages();
            return result;
        } finally {
            this.#compactionActive = false;
            if (this.#compactionController === controller) this.#compactionController = undefined;
            if (!this.#closing) {
                this.#status = previousStatus;
                this.#restartMetadataSettlement();
                this.#saveSession();
            }
        }
    }

    isSubagent(): boolean {
        return this.#agentMetadata.type === "subagent";
    }

    markRead(): boolean {
        if (this.isSubagent() || this.#unread === undefined) return false;
        this.#unread = undefined;
        this.#append("session_updated", { session: this.snapshot() });
        return true;
    }

    recordSubagentChanged(subagent: SubagentSummary): void {
        this.#append("subagent_changed", { subagent });
        this.#restartMetadataSettlement();
    }

    recordDescendantActivity(): void {
        this.#restartMetadataSettlement();
    }

    recordUserActivity(): void {
        this.#restartMetadataSettlement();
    }

    requestForSubagent(): CreateSessionRequest {
        return {
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            trackUnread: false,
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            modelId: this.#modelId,
            providerId: this.#providerId,
            ...(this.#request.apiKey !== undefined ? { apiKey: this.#request.apiKey } : {}),
            permissionMode: this.#permissionMode,
            workflowsEnabled: this.#workflowsEnabled,
            ...(this.#request.docker === undefined ? {} : { docker: this.#request.docker }),
        };
    }

    activeRunDebug(): boolean {
        return this.#activeRun?.debug === true;
    }

    externalControlContext(): AgentContext {
        return this.#ensureRuntime().context;
    }

    snapshot(): ProtocolSession {
        const snapshot = this.#agentSnapshot();
        const lastEventId = this.events.lastEventId();
        return {
            id: this.id,
            agentId: this.#agentId,
            archived: this.#archived,
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            archiveOnIdle: this.#request.archiveOnIdle === true,
            trackUnread: this.#request.trackUnread === true,
            ...(this.#unread === undefined ? {} : { unread: { ...this.#unread } }),
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            ...(this.#draft === undefined ? {} : { draft: this.#draft }),
            ...(this.#draftUpdatedAt === undefined ? {} : { draftUpdatedAt: this.#draftUpdatedAt }),
            environment: summarizeDockerExecution(this.#request.docker),
            providerId: this.#providerId,
            permissionMode: this.#permissionMode,
            modelId: this.#modelId,
            orderKey: this.#orderKey,
            modelLocked: this.#modelLocked(),
            models: this.#models,
            projectSecretIds: this.#secrets.projectIds(),
            secretIds: this.#secrets.ids(),
            sessionSecretIds: this.#secrets.sessionIds(),
            status: this.#status,
            snapshot,
            titleStatus: this.#titleStatus,
            ...(this.#recap !== undefined ? { recap: this.#recap } : {}),
            ...(this.#metadataUpdatedAt !== undefined
                ? { metadataUpdatedAt: this.#metadataUpdatedAt }
                : {}),
            ...(this.#metadataRunId !== undefined ? { metadataRunId: this.#metadataRunId } : {}),
            agent: this.agentMetadata(),
            pendingUserInputs: [
                ...new Map(
                    [
                        ...[...this.#pendingUserInputs.values()].map((pending) => pending.request),
                        ...[...this.#durableUserInputs.values()]
                            .filter((call) => call.status === "pending")
                            .map((call) => call.request),
                    ].map((request) => [request.requestId, request]),
                ).values(),
            ],
            mcpServers: this.#mcpServers,
            tasks: this.listTasks(),
            workflowsEnabled: this.#workflowsEnabled,
            workflows: this.listWorkflows(),
            backgroundProcesses: this.#runtime?.context.bash.activeSessions?.() ?? [],
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            ...(this.#usage.totalTokens === 0
                ? {}
                : { cumulativeUsage: structuredClone(this.#usage) }),
            externalTools: this.#externalToolDefinitions.map((definition) => ({ ...definition })),
            skills: this.#durableSkillDefinitions.map((definition) => ({ ...definition })),
            pendingExternalToolCalls: this.externalToolCalls({ status: "pending" }),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
            ...(this.#goal !== undefined ? { goal: { ...this.#goal } } : {}),
            ...(snapshot.effort !== undefined ? { effort: snapshot.effort } : {}),
            ...(snapshot.serviceTier !== undefined ? { serviceTier: snapshot.serviceTier } : {}),
            ...(this.#title !== undefined ? { title: this.#title } : {}),
            ...(this.#titleError !== undefined ? { titleError: this.#titleError } : {}),
            ...(this.#interruption !== undefined ? { interruption: this.#interruption } : {}),
            ...(lastEventId !== undefined ? { lastEventId } : {}),
        };
    }

    summary(): SessionSummary {
        return {
            id: this.id,
            archived: this.#archived,
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            archiveOnIdle: this.#request.archiveOnIdle === true,
            trackUnread: this.#request.trackUnread === true,
            ...(this.#unread === undefined ? {} : { unread: { ...this.#unread } }),
            cwd: this.#request.cwd,
            ...(this.#draft === undefined ? {} : { draft: this.#draft }),
            ...(this.#draftUpdatedAt === undefined ? {} : { draftUpdatedAt: this.#draftUpdatedAt }),
            environment: summarizeDockerExecution(this.#request.docker),
            providerId: this.#providerId,
            permissionMode: this.#permissionMode,
            modelId: this.#modelId,
            orderKey: this.#orderKey,
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            status: this.#status,
            titleStatus: this.#titleStatus,
            ...(this.#recap !== undefined ? { recap: this.#recap } : {}),
            sessionTokenCount: { ...this.#sessionTokenCount },
            ...(this.#metadataUpdatedAt !== undefined
                ? { metadataUpdatedAt: this.#metadataUpdatedAt }
                : {}),
            ...(this.#metadataRunId !== undefined ? { metadataRunId: this.#metadataRunId } : {}),
            createdAt: this.events.firstCreatedAt() ?? this.#now(),
            updatedAt: this.events.lastCreatedAt() ?? this.#now(),
            ...(this.#lastMessageAt !== undefined ? { lastMessageAt: this.#lastMessageAt } : {}),
            ...(this.#title !== undefined ? { title: this.#title } : {}),
            ...(this.#titleError !== undefined ? { titleError: this.#titleError } : {}),
            ...(this.#interruption !== undefined ? { interruption: this.#interruption } : {}),
        };
    }

    state(): PersistedSessionState {
        const activeRunId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        const contextMessages =
            runtimeSnapshot?.contextMessages === undefined
                ? this.#contextMessages
                : [
                      ...runtimeSnapshot.contextMessages,
                      ...runtimeSnapshot.queue.map((queued) => queued.message),
                  ];
        const state: PersistedSessionState = {
            ...(this.#activeSince === undefined ? {} : { activeSince: this.#activeSince }),
            agent: this.agentMetadata(),
            agentId: this.#agentId,
            archived: this.#archived,
            archiveOnIdle: this.#request.archiveOnIdle === true,
            trackUnread: this.#request.trackUnread === true,
            ...(this.#unread === undefined ? {} : { unread: { ...this.#unread } }),
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            ...(this.#draft === undefined ? {} : { draft: this.#draft }),
            ...(this.#draftUpdatedAt === undefined ? {} : { draftUpdatedAt: this.#draftUpdatedAt }),
            elapsedMs: this.#elapsedMs,
            ...(this.#request.docker === undefined ? {} : { docker: this.#request.docker }),
            ...(contextMessages !== undefined ? { contextMessages: [...contextMessages] } : {}),
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            id: this.id,
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            ...(this.#goal !== undefined ? { goal: { ...this.#goal } } : {}),
            ...(this.#interruption !== undefined ? { interruption: this.#interruption } : {}),
            ...(this.#lastMessageAt !== undefined ? { lastMessageAt: this.#lastMessageAt } : {}),
            ...(this.#metadataRunId !== undefined ? { metadataRunId: this.#metadataRunId } : {}),
            ...(this.#metadataUpdatedAt !== undefined
                ? { metadataUpdatedAt: this.#metadataUpdatedAt }
                : {}),
            messages: [...this.#messages],
            modelId: this.#modelId,
            models: this.#models,
            orderKey: this.#orderKey,
            providerId: this.#providerId,
            permissionMode: this.#permissionMode,
            projectId: this.#projectId,
            ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
            secretIds: this.#secrets.sessionIds(),
            queuedRuns: [...this.#queue],
            ...(this.#recap !== undefined ? { recap: this.#recap } : {}),
            nextTaskId: this.#taskList.nextId,
            status: this.#status,
            tasks: this.listTasks(),
            ...(this.#title !== undefined ? { title: this.#title } : {}),
            ...(this.#titleError !== undefined ? { titleError: this.#titleError } : {}),
            titleStatus: this.#titleStatus,
            totalTokens: this.#totalTokens,
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            usage: structuredClone(this.#usage),
            tools: this.#tools,
            externalToolCalls: this.externalToolCalls(),
            durableUserInputs: [...this.#durableUserInputs.values()].map((call) =>
                structuredClone(call),
            ),
            externalTools: this.#externalToolDefinitions.map((definition) => ({ ...definition })),
            skills: this.#durableSkillDefinitions.map((definition) => ({ ...definition })),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
            workflowsEnabled: this.#workflowsEnabled,
            workflows: [...this.#workflowRuns.values()].map((run) => ({
                agentCalls: [...run.agentCalls],
                ...(run.checkpoint === undefined
                    ? {}
                    : {
                          checkpoint: {
                              nextAgentCallIndex: run.checkpoint.nextAgentCallIndex,
                              phase: run.checkpoint.phase,
                              snapshotBase64: Buffer.from(run.checkpoint.snapshot).toString(
                                  "base64",
                              ),
                          },
                      }),
                state: cloneWorkflowRun(run.state),
            })),
        };
        if (activeRunId !== undefined) {
            state.activeRunId = activeRunId;
        }
        return state;
    }

    submit(
        request: SessionSubmitMessageRequest,
        options: { source?: "notification" } = {},
    ): SubmitMessageResponse {
        this.#assertAcceptingWork();
        this.#assertConfigurationCanApply(request);
        if (request.clientSubmissionId !== undefined) {
            const existingEvent = this.events.messageSubmission(request.clientSubmissionId);
            if (existingEvent !== undefined) {
                return {
                    eventId: existingEvent.id,
                    runId: existingEvent.data.runId,
                    sessionId: this.id,
                };
            }
            const existingMessage = this.#submittedUserMessages.get(request.clientSubmissionId);
            if (existingMessage?.message.role === "user" && existingMessage.runId !== undefined) {
                const recoveredEvent = this.#append("message_submitted", {
                    delivery: "run",
                    displayText: request.displayText ?? request.text,
                    message: existingMessage.message,
                    runId: existingMessage.runId,
                    ...(options.source === undefined ? {} : { source: options.source }),
                });
                return {
                    eventId: recoveredEvent.id,
                    runId: existingMessage.runId,
                    sessionId: this.id,
                };
            }
        }
        if (options.source === undefined && request.provenance !== "agent") {
            this.setArchived(false);
        }
        const runId = createId();
        const createdAt = this.#now();
        const displayText = request.displayText ?? request.text;
        const blocks: readonly ContentBlock[] = request.content ?? [
            { type: "text", text: createCodeReviewPrompt(request.text) ?? request.text },
        ];
        const userMessage: UserMessage = {
            role: "user",
            id: request.clientSubmissionId ?? createId(),
            blocks,
            ...(options.source === "notification" || request.provenance === "agent"
                ? { provenance: "agent" as const }
                : {}),
            ...(request.encryptedAgentMessage === undefined
                ? {}
                : { encryptedAgentMessage: request.encryptedAgentMessage }),
            ...(request.agentMessageTriggerTurn === undefined
                ? {}
                : { agentMessageTriggerTurn: request.agentMessageTriggerTurn }),
        };
        const visibleMessage: UserMessage = {
            role: "user",
            id: userMessage.id,
            ...(options.source === "notification" || request.provenance === "agent"
                ? { provenance: "agent" as const }
                : {}),
            blocks: blocks.some((block) => block.type === "image")
                ? blocks
                : displayText.length > 0
                  ? [{ type: "text", text: displayText }]
                  : [],
        };
        const queued: PersistedQueuedRun = {
            ...(request.debug === true
                ? {
                      debug: true,
                      debugDirectory: createRequestDebugDirectory(
                          this.#request.cwd,
                          runId,
                          createdAt,
                      ),
                  }
                : {}),
            displayText,
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
            ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
            ...(request.interactive === undefined ? {} : { interactive: request.interactive }),
            kind: "user",
            runId,
            text: request.text,
            userMessage,
            ...(request.externalTools === undefined
                ? {}
                : {
                      externalTools: request.externalTools.map((definition) => ({ ...definition })),
                  }),
            ...(request.skills === undefined
                ? {}
                : { skills: request.skills.map((definition) => ({ ...definition })) }),
            ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
        };

        this.#interruption = undefined;
        this.#queue.push(queued);
        this.#persistence?.insertQueuedRun(this.id, queued);
        this.#status = this.#activeRun === undefined ? "queued" : "running";
        this.#lastMessageAt = this.#now();
        this.#separateModelContextFromVisibleTranscript();
        this.#storeMessage(this.#messages.length, visibleMessage, false, runId);
        const event = this.#append("message_submitted", {
            delivery: "run",
            displayText,
            message: visibleMessage,
            runId,
            ...(options.source === undefined ? {} : { source: options.source }),
        });
        const debugLog = this.#debugLogFor(queued);
        void debugLog?.record("request", {
            agent: this.agentMetadata(),
            displayText,
            modelId: this.#modelId,
            permissionMode: this.#permissionMode,
            providerId: this.#providerId,
            request: {
                ...(request.content === undefined ? {} : { content: request.content }),
                text: request.text,
            },
            runId,
            sessionId: this.id,
        });
        this.#startDrainQueue();
        this.#restartMetadataSettlement();
        return {
            ...(queued.debugDirectory === undefined
                ? {}
                : { debugDirectory: queued.debugDirectory }),
            eventId: event.id,
            runId,
            sessionId: this.id,
        };
    }

    steer(request: SteerMessageRequest): SteerMessageResponse {
        this.#assertAcceptingWork();
        if (request.clientSubmissionId !== undefined) {
            const existingEvent = this.events.messageSubmission(request.clientSubmissionId);
            if (existingEvent !== undefined) {
                return {
                    delivery: existingEvent.data.delivery ?? "run",
                    eventId: existingEvent.id,
                    runId: existingEvent.data.runId,
                    sessionId: this.id,
                };
            }
        }
        const activeRun = this.#activeRun;
        if (
            activeRun === undefined ||
            (request.expectedRunId !== undefined && activeRun.runId !== request.expectedRunId)
        ) {
            return { ...this.submit(request), delivery: "run" };
        }
        // Presence alone decides this, not whether the value differs from the current one, so the
        // rule does not quietly depend on what the session happens to be set to right now.
        if (
            request.externalTools !== undefined ||
            request.skills !== undefined ||
            request.systemPrompt !== undefined ||
            request.effort !== undefined ||
            request.modelId !== undefined ||
            request.providerId !== undefined ||
            request.serviceTier !== undefined
        ) {
            throw new Error(
                "The model, reasoning effort, fast mode, external functions, durable skills, and the system prompt can only be changed by submitting a message, which runs once the current response finishes.",
            );
        }
        this.setArchived(false);
        const displayText = request.displayText ?? request.text;
        const blocks: readonly ContentBlock[] = request.content ?? [
            { type: "text", text: request.text },
        ];
        const userMessage: UserMessage = {
            role: "user",
            id: request.clientSubmissionId ?? createId(),
            blocks,
        };

        const agent = this.#ensureRuntime().agent;
        const continuation = this.#pendingSteeringContinuations.get(activeRun.runId);
        if (continuation !== undefined && !continuation.cancelled) {
            agent.enqueueMessage(userMessage);
            this.#storeMessage(this.#messages.length, userMessage, false, activeRun.runId);
            this.#interruption = undefined;
            this.#lastMessageAt = this.#now();
            const event = this.#append("message_submitted", {
                delivery: "steer",
                displayText,
                message: userMessage,
                runId: activeRun.runId,
            });
            this.#append("steering_applied", {
                messageIds: [userMessage.id],
                runId: activeRun.runId,
            });
            this.#restartMetadataSettlement();
            return {
                delivery: "steer",
                eventId: event.id,
                runId: activeRun.runId,
                sessionId: this.id,
            };
        }
        const pending = agent.status === "running";
        if (pending) {
            this.#pendingSteeringMessages.set(userMessage.id, {
                message: userMessage,
                runId: activeRun.runId,
            });
            agent.steerMessage(userMessage);
        } else {
            agent.enqueueMessage(userMessage);
            this.#storeMessage(this.#messages.length, userMessage, false, activeRun.runId);
        }
        this.#interruption = undefined;
        this.#lastMessageAt = this.#now();
        const event = this.#append("message_submitted", {
            delivery: "steer",
            displayText,
            message: userMessage,
            runId: activeRun.runId,
        });
        if (!pending) {
            this.#append("steering_applied", {
                messageIds: [userMessage.id],
                runId: activeRun.runId,
            });
        }
        this.#restartMetadataSettlement();
        return {
            delivery: "steer",
            eventId: event.id,
            runId: activeRun.runId,
            sessionId: this.id,
        };
    }

    deliverNotification(
        request: SubmitMessageRequest,
    ): SubmitMessageResponse | SteerMessageResponse {
        this.#assertAcceptingWork();
        if (this.#activeRun === undefined) {
            return this.submit(request, { source: "notification" });
        }

        const activeRun = this.#activeRun;
        const displayText = request.displayText ?? request.text;
        const userMessage: UserMessage = {
            blocks: request.content ?? [{ type: "text", text: request.text }],
            id: createId(),
            provenance: "agent",
            role: "user",
        };
        const visibleMessage: UserMessage = {
            blocks: displayText.length > 0 ? [{ type: "text", text: displayText }] : [],
            id: userMessage.id,
            provenance: "agent",
            role: "user",
        };
        const agent = this.#ensureRuntime().agent;

        const pending = agent.status === "running";
        if (pending) {
            this.#pendingSteeringMessages.set(userMessage.id, {
                message: visibleMessage,
                runId: activeRun.runId,
            });
            agent.steerMessage(userMessage);
        } else {
            agent.enqueueMessage(userMessage);
            this.#storeMessage(this.#messages.length, visibleMessage, false, activeRun.runId);
        }
        this.#interruption = undefined;
        const event = this.#append("message_submitted", {
            delivery: "steer",
            displayText,
            message: visibleMessage,
            runId: activeRun.runId,
            source: "notification",
        });
        if (!pending) {
            this.#append("steering_applied", {
                messageIds: [userMessage.id],
                runId: activeRun.runId,
            });
        }
        return {
            delivery: "steer",
            eventId: event.id,
            runId: activeRun.runId,
            sessionId: this.id,
        };
    }

    deliverAgentMessage(message: UserMessage): void {
        this.#assertAcceptingWork();
        const agent = this.#ensureRuntime().agent;
        const activeRun = this.#activeRun;
        if (activeRun !== undefined && agent.status === "running") {
            this.#pendingSteeringMessages.set(message.id, {
                message,
                runId: activeRun.runId,
            });
            agent.steerMessage(message);
            return;
        }
        agent.enqueueMessage(message);
        this.#storeMessage(
            this.#messages.length,
            message,
            false,
            activeRun?.runId ?? this.#lastSessionRunId ?? `agent:${message.id}`,
        );
        this.#lastMessageAt = this.#now();
        this.#saveSession();
    }

    subagentSummary(): SubagentSummary {
        if (
            this.#agentMetadata.type !== "subagent" ||
            this.#agentMetadata.parentSessionId === undefined
        ) {
            throw new Error("Only subagent sessions have subagent summaries.");
        }

        const messages = this.#committedMessages();
        const latestText = limitInspectionText(findLastAgentResponseText(messages));
        const prompt = limitInspectionText(findFirstUserRequestText(messages));
        return {
            ...(this.#activeSince === undefined ? {} : { activeSince: this.#activeSince }),
            agentId: this.#agentId,
            createdAt: this.events.firstCreatedAt() ?? this.#now(),
            depth: this.#agentMetadata.depth,
            description: this.#agentMetadata.description ?? "Delegated task",
            elapsedMs: this.#elapsedMs,
            id: this.id,
            ...(latestText === undefined ? {} : { latestText }),
            modelId: this.#modelId,
            parentSessionId: this.#agentMetadata.parentSessionId,
            ...(this.#agentMetadata.parentToolCallId !== undefined
                ? { parentToolCallId: this.#agentMetadata.parentToolCallId }
                : {}),
            ...(prompt === undefined ? {} : { prompt }),
            status: this.#status,
            sessionTokenCount: structuredClone(this.#sessionTokenCount),
            ...(this.#agentMetadata.taskName !== undefined
                ? { taskName: this.#agentMetadata.taskName }
                : {}),
            totalTokens: this.#totalTokens,
            updatedAt: this.events.lastCreatedAt() ?? this.#now(),
            ...(this.#usage.totalTokens === 0 ? {} : { usage: structuredClone(this.#usage) }),
        };
    }

    lastErrorMessage(): string | undefined {
        const events = this.events.since(undefined) ?? [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event?.type === "run_error") return event.data.errorMessage;
        }
        return undefined;
    }

    waitForRun(runId: string): Promise<SessionRunCompletion> {
        const completed = this.#completionForRun(runId);
        if (completed !== undefined) {
            return Promise.resolve(completed);
        }

        return new Promise((resolve) => {
            const unsubscribe = this.events.subscribe((event) => {
                if (
                    (event.type !== "run_finished" && event.type !== "run_error") ||
                    event.data.runId !== runId
                ) {
                    return;
                }
                unsubscribe();
                resolve(
                    event.type === "run_error"
                        ? { errorMessage: event.data.errorMessage, status: "error" }
                        : {
                              status: event.data.stopReason === "aborted" ? "aborted" : "completed",
                          },
                );
            });
        });
    }

    externalToolCalls(options: { status?: ExternalToolCall["status"] } = {}): ExternalToolCall[] {
        return [...this.#externalToolCalls.values()]
            .filter((call) => options.status === undefined || call.status === options.status)
            .sort(
                (left, right) =>
                    left.createdAt - right.createdAt || left.toolCallIndex - right.toolCallIndex,
            )
            .map(cloneExternalToolCall);
    }

    hasDurableToolRun(): boolean {
        const runId = this.#activeRun?.runId ?? this.#restoredActiveRunId;
        if (runId === undefined) return false;
        const calls = [
            ...[...this.#externalToolCalls.values()]
                .filter((call) => call.runId === runId && call.status !== "cancelled")
                .map((call) => ({ consumed: call.consumed, toolCallId: call.toolCallId })),
            ...[...this.#durableUserInputs.values()]
                .filter((call) => call.runId === runId && call.status !== "cancelled")
                .map((call) => ({ consumed: call.consumed, toolCallId: call.toolCallId })),
        ];
        if (calls.length === 0) return false;
        if (calls.some((call) => !call.consumed)) return true;
        const resultIds = new Set(calls.map((call) => call.toolCallId));
        const resultPosition = this.#messages.reduce(
            (latest, entry) =>
                entry.message.role === "agent" &&
                entry.message.blocks.some(
                    (block) => block.type === "tool_result" && resultIds.has(block.toolCallId),
                )
                    ? Math.max(latest, entry.position)
                    : latest,
            -1,
        );
        return (
            resultPosition >= 0 &&
            !this.#messages.some(
                (entry) => entry.runId === runId && entry.position > resultPosition,
            )
        );
    }

    resumeDurableToolRun(): void {
        if (this.#workspaceArchived) return;
        if (this.#resumingDurableToolRun) {
            this.#resumeDurableToolRunAgain = true;
            return;
        }
        this.#resumingDurableToolRun = true;
        this.#resumeDurableToolRunAgain = false;
        void this.#resumeDurableToolRun()
            .catch(() => undefined)
            .finally(() => {
                this.#resumingDurableToolRun = false;
                if (this.#resumeDurableToolRunAgain) this.resumeDurableToolRun();
            });
    }

    async #resumeDurableToolRun(): Promise<void> {
        if (this.#workspaceArchived || this.#closing || this.#activeRun !== undefined) return;
        const runId = this.#restoredActiveRunId;
        if (runId === undefined || !this.hasDurableToolRun()) return;
        this.#reconcileExternalToolConsumption(runId);
        this.#reconcileDurableUserInputConsumption(runId);
        while (true) {
            const call = [...this.#durableUserInputs.values()].find(
                (candidate) =>
                    candidate.runId === runId &&
                    !candidate.consumed &&
                    (candidate.status === "answered" || candidate.status === "executing"),
            );
            if (call === undefined) break;
            if (call.status === "executing") {
                call.result = createErrorToolResultBlock(
                    { id: call.toolCallId, name: call.toolName },
                    `Tool '${call.toolName}' was interrupted after approval and was not replayed.`,
                    { kind: "interrupted" },
                );
                call.status = "completed";
                call.resolvedAt = this.#now();
                this.#persistence?.upsertDurableUserInput?.(call);
            } else if (call.status === "answered") {
                await this.#resumeAnsweredDurableUserInput(call);
                if (this.#activeRun !== undefined) return;
            }
        }
        const unconsumed = [
            ...[...this.#externalToolCalls.values()]
                .filter(
                    (call) => call.runId === runId && !call.consumed && call.status !== "cancelled",
                )
                .map((call) => ({
                    batchId: call.batchId,
                    call,
                    createdAt: call.createdAt,
                    kind: "external" as const,
                    pending: call.status === "pending",
                    toolCallIndex: call.toolCallIndex,
                })),
            ...[...this.#durableUserInputs.values()]
                .filter(
                    (call) => call.runId === runId && !call.consumed && call.status !== "cancelled",
                )
                .map((call) => ({
                    batchId: call.batchId,
                    call,
                    createdAt: call.createdAt,
                    kind: "user_input" as const,
                    pending: call.status !== "completed",
                    toolCallIndex: call.toolCallIndex,
                })),
        ].sort(
            (left, right) =>
                left.createdAt - right.createdAt || left.toolCallIndex - right.toolCallIndex,
        );
        if (unconsumed.length > 0) {
            const batchId = unconsumed[0]?.batchId;
            const batch = unconsumed.filter((call) => call.batchId === batchId);
            if (batch.some((entry) => entry.pending)) return;
            const resultMessage: AgentMessage = {
                blocks: batch
                    .sort((left, right) => left.toolCallIndex - right.toolCallIndex)
                    .map((entry) => {
                        if (entry.kind === "external") {
                            return this.#externalToolResultBlock(entry.call);
                        }
                        if (entry.call.result === undefined) {
                            throw new Error("A durable user input has no tool result.");
                        }
                        return structuredClone(entry.call.result);
                    }),
                id: createId(),
                role: "agent",
            };
            this.#storeMessage(this.#messages.length, resultMessage, false, runId);
            for (const entry of batch) {
                entry.call.consumed = true;
                if (entry.kind === "external") {
                    this.#persistence?.upsertExternalToolCall?.(entry.call);
                } else {
                    this.#persistence?.upsertDurableUserInput?.(entry.call);
                }
            }
            this.#pruneExternalToolCalls();
            this.#pruneDurableUserInputs();
            this.#append("agent_message", { message: resultMessage, runId });
        }
        this.#contextMessages = undefined;
        void this.#runtime?.agent.close();
        this.#runtime = undefined;
        const continuation = () => this.#continueDurableToolRun(runId);
        const running = this.#taskDrain?.run(continuation) ?? continuation();
        await running;
    }

    resolveExternalToolCall(
        callId: string,
        resolution: ExternalToolCallResolution,
    ): ResolveExternalToolCallResponse | undefined {
        const call = this.#externalToolCalls.get(callId);
        if (call === undefined) return undefined;
        if (call.resolution !== undefined) {
            if (!isDeepStrictEqual(call.resolution, resolution)) {
                throw new Error("This external function call already has a different result.");
            }
            return { accepted: false, call: cloneExternalToolCall(call) };
        }
        if (call.status !== "pending") {
            throw new Error("This external function call is no longer waiting for a result.");
        }
        if (
            call.skill !== undefined &&
            resolution.status === "completed" &&
            (resolution.content !== undefined || typeof resolution.output !== "string")
        ) {
            throw new Error(
                "A durable skill result must provide the complete SKILL.md as text output.",
            );
        }
        call.resolution = cloneExternalResolution(resolution);
        call.resolvedAt = this.#now();
        call.status = resolution.status;
        this.#persistence?.upsertExternalToolCall?.(call);
        this.#append("external_tool_call_resolved", { call: cloneExternalToolCall(call) });
        const waiter = this.#externalToolWaiters.get(call.id);
        if (waiter !== undefined) {
            this.#externalToolWaiters.delete(call.id);
            waiter.resolve(cloneExternalResolution(resolution));
        } else {
            this.resumeDurableToolRun();
        }
        return { accepted: true, call: cloneExternalToolCall(call) };
    }

    async #invokeExternalTool(
        definition: ExternalToolDefinition,
        request: {
            arguments: unknown;
            batchId: string;
            providerToolCallId?: string;
            toolCallId: string;
            toolCallIndex: number;
        },
        signal?: AbortSignal,
        skill?: DurableSkillDefinition,
    ): Promise<ExternalToolCallResolution> {
        const runId = this.#activeRun?.runId;
        if (runId === undefined) throw new Error("The external function has no active run.");
        const existing = [...this.#externalToolCalls.values()].find(
            (call) =>
                call.runId === runId &&
                call.batchId === request.batchId &&
                call.toolCallId === request.toolCallId,
        );
        if (existing?.resolution !== undefined) return cloneExternalResolution(existing.resolution);
        const call: ExternalToolCall = existing ?? {
            arguments: request.arguments,
            batchId: request.batchId,
            consumed: false,
            createdAt: this.#now(),
            definition: { ...definition },
            id: createId(),
            runId,
            sessionId: this.id,
            status: "pending",
            ...(request.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: request.providerToolCallId }),
            toolCallId: request.toolCallId,
            toolCallIndex: request.toolCallIndex,
            ...(skill === undefined ? {} : { skill: { ...skill } }),
        };
        if (existing === undefined) {
            this.#externalToolCalls.set(call.id, call);
            this.#persistence?.upsertExternalToolCall?.(call);
            this.#append("external_tool_call_requested", { call: cloneExternalToolCall(call) });
        }
        this.#pruneDurableUserInputs();
        return new Promise<ExternalToolCallResolution>((resolve, reject) => {
            let waiter: ExternalToolWaiter;
            const abort = () => {
                if (this.#externalToolWaiters.get(call.id) !== waiter) return;
                this.#externalToolWaiters.delete(call.id);
                reject(new Error(`External function ${definition.name} was interrupted.`));
            };
            waiter = {
                reject: (error) => {
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                },
                resolve: (resolution) => {
                    signal?.removeEventListener("abort", abort);
                    resolve(resolution);
                },
            };
            this.#externalToolWaiters.set(call.id, waiter);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted === true) abort();
        });
    }

    #externalToolResultBlock(call: ExternalToolCall): ToolResultBlock {
        const resolution = call.resolution;
        if (resolution === undefined) {
            throw new Error(`External function ${call.definition.name} has no result.`);
        }
        const failed = resolution.status === "failed";
        const display =
            call.skill === undefined
                ? `External function ${call.definition.name} ${failed ? "failed" : "completed"}`
                : `Skill ${call.skill.name} ${failed ? "could not be read" : "read"}`;
        return {
            display,
            ...(failed
                ? {
                      failure: {
                          kind: "execution_failed" as const,
                          message: resolution.error.message,
                      },
                      isError: true,
                  }
                : {}),
            rendered: externalToolResolutionToContent(resolution),
            ...(call.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: call.providerToolCallId }),
            toolCallId: call.toolCallId,
            toolName: call.definition.name,
            type: "tool_result",
        };
    }

    #reconcileExternalToolConsumption(runId: string): void {
        const consumedToolCallIds = new Set(
            this.#messages.flatMap((entry) =>
                entry.message.role !== "agent"
                    ? []
                    : entry.message.blocks.flatMap((block) =>
                          block.type === "tool_result" ? [block.toolCallId] : [],
                      ),
            ),
        );
        for (const call of this.#externalToolCalls.values()) {
            if (
                call.runId !== runId ||
                call.consumed ||
                !consumedToolCallIds.has(call.toolCallId)
            ) {
                continue;
            }
            call.consumed = true;
            this.#persistence?.upsertExternalToolCall?.(call);
        }
        this.#pruneExternalToolCalls();
    }

    async #resumeAnsweredDurableUserInput(call: DurableUserInputCall): Promise<void> {
        const response = call.response;
        if (response === undefined || call.status !== "answered") return;
        const runtime = this.#ensureRuntime();
        const tool = runtime.agent.tools.find((candidate) => candidate.name === call.toolName);
        if (tool?.resolveUserInput === undefined) {
            call.result = createErrorToolResultBlock(
                {
                    id: call.toolCallId,
                    name: call.toolName,
                    ...(call.providerToolCallId === undefined
                        ? {}
                        : { providerToolCallId: call.providerToolCallId }),
                },
                `Tool '${call.toolName}' cannot restore its durable user answer.`,
                { kind: "execution_failed" },
            );
        } else {
            const result = tool.resolveUserInput(response, call.toolArguments as never);
            call.result = createToolResultBlock(
                tool,
                call.toolArguments,
                result,
                call.toolCallId,
                undefined,
                call.providerToolCallId,
            );
        }
        call.status = "completed";
        this.#persistence?.upsertDurableUserInput?.(call);
    }

    #reconcileDurableUserInputConsumption(runId: string): void {
        const consumedToolCallIds = new Set(
            this.#messages.flatMap((entry) =>
                entry.message.role !== "agent"
                    ? []
                    : entry.message.blocks.flatMap((block) =>
                          block.type === "tool_result" ? [block.toolCallId] : [],
                      ),
            ),
        );
        for (const call of this.#durableUserInputs.values()) {
            if (
                call.runId !== runId ||
                call.consumed ||
                !consumedToolCallIds.has(call.toolCallId)
            ) {
                continue;
            }
            call.consumed = true;
            this.#persistence?.upsertDurableUserInput?.(call);
        }
        this.#pruneDurableUserInputs();
    }

    #cancelDurableUserInput(call: DurableUserInputCall): void {
        if (call.status === "cancelled" || call.consumed) return;
        call.status = "cancelled";
        call.resolvedAt = this.#now();
        this.#persistence?.upsertDurableUserInput?.(call);
        this.#append("user_input_resolved", {
            requestId: call.request.requestId,
            status: "cancelled",
        });
    }

    #cancelDurableUserInputs(runId: string): void {
        for (const call of this.#durableUserInputs.values()) {
            if (call.runId === runId && !call.consumed) this.#cancelDurableUserInput(call);
        }
        this.#pruneDurableUserInputs();
    }

    #pruneDurableUserInputs(): void {
        const eligible = [...this.#durableUserInputs.values()]
            .filter((call) => call.status === "cancelled" || call.consumed)
            .sort(
                (left, right) =>
                    (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt) ||
                    right.toolCallIndex - left.toolCallIndex,
            );
        for (const call of eligible.slice(MAX_RETAINED_DURABLE_USER_INPUTS)) {
            this.#durableUserInputs.delete(call.request.requestId);
        }
        this.#persistence?.pruneDurableUserInputs?.(this.id, MAX_RETAINED_DURABLE_USER_INPUTS);
    }

    #cancelExternalToolCalls(runId: string): void {
        for (const call of this.#externalToolCalls.values()) {
            if (call.runId !== runId || call.status !== "pending") continue;
            call.status = "cancelled";
            call.resolvedAt = this.#now();
            this.#persistence?.upsertExternalToolCall?.(call);
            this.#append("external_tool_call_resolved", { call: cloneExternalToolCall(call) });
            const waiter = this.#externalToolWaiters.get(call.id);
            if (waiter !== undefined) {
                this.#externalToolWaiters.delete(call.id);
                waiter.reject(
                    new Error(`External function ${call.definition.name} was cancelled.`),
                );
            }
        }
        this.#pruneExternalToolCalls();
    }

    #pruneExternalToolCalls(): void {
        const eligible = [...this.#externalToolCalls.values()]
            .filter((call) => call.status === "cancelled" || call.consumed)
            .sort(
                (left, right) =>
                    (right.resolvedAt ?? right.createdAt) - (left.resolvedAt ?? left.createdAt) ||
                    right.toolCallIndex - left.toolCallIndex,
            );
        for (const call of eligible.slice(MAX_RETAINED_EXTERNAL_TOOL_CALLS)) {
            this.#externalToolCalls.delete(call.id);
        }
        this.#persistence?.pruneExternalToolCalls?.(this.id, MAX_RETAINED_EXTERNAL_TOOL_CALLS);
    }

    async #continueDurableToolRun(runId: string): Promise<void> {
        if (this.#activeRun !== undefined || this.#closing) return;
        const controller = new AbortController();
        this.#activeRun = { controller, debug: false, kind: "user", runId };
        this.#restoredActiveRunId = undefined;
        this.#status = "running";
        this.#activeSince ??= this.#now();
        let runtime: CodingAssistantRuntime | undefined;
        try {
            runtime = this.#ensureRuntime();
            const result = await runtime.agent.run({
                signal: controller.signal,
                onEvent: (event) => this.#appendAgentEvent(runId, event),
                onMessage: (message) => this.#appendAgentMessage(runId, message),
            });
            if (this.#activeRun?.runId !== runId) return;
            this.#appendRunFinished(runId, result);
        } catch (error) {
            if (this.#activeRun?.runId !== runId) return;
            if (!this.#workspaceArchived) this.#status = "error";
            this.#finishElapsedInterval();
            this.#activeRun = undefined;
            this.#append("run_error", {
                errorMessage: errorToMessage(error),
                modelLocked: this.#modelLocked(),
                runId,
            });
        } finally {
            if (this.#activeRun?.runId === runId) this.#activeRun = undefined;
            this.#syncContextMessages();
            this.#saveSession();
        }
    }

    #agentSnapshot(): AgentSnapshot {
        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        return {
            id: this.#agentId,
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            providerId: this.#providerId,
            modelId: this.#modelId,
            status: this.#agentStatus(),
            messages: this.#committedMessages(),
            queue: runtimeSnapshot?.queue ?? [],
            tools: this.#tools,
            ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
            ...(this.#serviceTier !== undefined ? { serviceTier: this.#serviceTier } : {}),
            ...((runtimeSnapshot?.contextMessages ?? this.#contextMessages) !== undefined
                ? {
                      contextMessages: [
                          ...(runtimeSnapshot?.contextMessages ?? this.#contextMessages ?? []),
                      ].filter((message) => !isInternalMessage(message)),
                  }
                : {}),
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
            ...(runtimeSnapshot?.lastRunId !== undefined
                ? { lastRunId: runtimeSnapshot.lastRunId }
                : {}),
        };
    }

    #agentStatus(): AgentSnapshot["status"] {
        if (this.#status === "running") {
            return "running";
        }
        if (this.#status === "aborted") {
            return "aborted";
        }
        return "idle";
    }

    #recordTasksChanged(): void {
        this.#append("tasks_changed", { tasks: this.listTasks() });
    }

    async #ensureMcpTools(
        runtime: CodingAssistantRuntime,
        signal?: AbortSignal,
        interactive = true,
    ): Promise<void> {
        if (
            this.#mcpLoaded &&
            this.#permissionMode !== "auto" &&
            this.#permissionMode !== "full_access"
        ) {
            return;
        }
        if (this.#mcpToolProvider === undefined) {
            this.#mcpLoaded = true;
            return;
        }

        const permissionMode = this.#permissionMode;
        const mcpLoadOptions =
            !this.isSubagent() &&
            interactive &&
            (permissionMode === "auto" || permissionMode === "full_access")
                ? {
                      requestTrust: (request: McpServerTrustRequest) =>
                          this.#requestMcpTrust(request, signal),
                  }
                : {};
        const loaded = await this.#mcpToolProvider.load(
            this.#request.cwd,
            permissionMode,
            mcpLoadOptions,
        );
        if (this.#permissionMode !== permissionMode) {
            await loaded.release?.().catch(() => undefined);
            return;
        }
        const previousRelease = this.#mcpToolRelease;
        try {
            const baseTools = runtime.agent.tools.filter(
                (tool) => !this.#mcpToolNames.has(tool.name),
            );
            const baseToolNames = new Set(baseTools.map((tool) => tool.name));
            const merged = mergeMcpTools(baseTools, loaded);
            runtime.agent.setTools(merged.tools);
            this.#mcpToolNames = new Set(
                merged.tools
                    .filter((tool) => !baseToolNames.has(tool.name))
                    .map((tool) => tool.name),
            );
            this.#tools = runtime.agent.tools.map((tool) => tool.name);
            const serversChanged =
                JSON.stringify(this.#mcpServers) !== JSON.stringify(merged.servers);
            this.#mcpServers = merged.servers;
            this.#mcpLoaded = true;
            this.#mcpToolRelease = loaded.release;
            if (serversChanged && merged.servers.length > 0) {
                this.#append("mcp_servers_changed", { servers: merged.servers });
            }
        } catch (error) {
            await loaded.release?.().catch(() => undefined);
            throw error;
        }
        await previousRelease?.().catch(() => undefined);
    }

    async #requestMcpTrust(request: McpServerTrustRequest, signal?: AbortSignal): Promise<boolean> {
        const response = await this.requestUserInput(
            createMcpTrustUserInputRequest(request),
            signal === undefined ? {} : { signal },
        );
        return response.answers.mcp_trust?.includes(MCP_TRUST_ANSWER) === true;
    }

    #removeMcpTools(runtime: CodingAssistantRuntime | undefined): void {
        if (runtime !== undefined && this.#mcpToolNames.size > 0) {
            runtime.agent.setTools(
                runtime.agent.tools.filter((tool) => !this.#mcpToolNames.has(tool.name)),
            );
            this.#tools = runtime.agent.tools.map((tool) => tool.name);
        }
        this.#mcpLoaded = false;
        this.#mcpServers = [];
        this.#mcpToolNames.clear();
        this.#releaseMcpToolLease();
        this.#append("mcp_servers_changed", { servers: [] });
    }

    #releaseMcpToolLease(): void {
        const release = this.#mcpToolRelease;
        this.#mcpToolRelease = undefined;
        void release?.().catch(() => undefined);
    }

    #append<TType extends SessionEvent["type"]>(
        type: TType,
        data: Extract<SessionEvent, { type: TType }>["data"],
    ): Extract<SessionEvent, { type: TType }> {
        const event = {
            createdAt: this.#now(),
            data,
            id: this.#createEventId(),
            sessionId: this.id,
            type,
        } as Extract<SessionEvent, { type: TType }>;
        if (this.#workspaceArchived) return event;
        if (!this.isSubagent() && this.#request.trackUnread === true) {
            this.#unread = sessionUnreadStateAfterEvent(this.#unread, event);
        }
        const previousSessionTokenCount = this.#sessionTokenCount;
        this.#sessionTokenCount =
            sessionTokenCountAfterEvent(this.#sessionTokenCount, event) ??
            previousSessionTokenCount;
        try {
            this.events.append(event);
        } catch (error) {
            this.#sessionTokenCount = previousSessionTokenCount;
            throw error;
        }
        this.#saveSession();
        return event;
    }

    #recordWorkflowUpdate(update: WorkflowRunUpdate): void {
        this.#append("workflow_changed", { update });
        this.#restartMetadataSettlement();
    }

    #secretAttachmentData(): {
        projectSecretIds: readonly string[];
        secretIds: readonly string[];
        sessionSecretIds: readonly string[];
    } {
        return {
            projectSecretIds: this.#secrets.projectIds(),
            secretIds: this.#secrets.ids(),
            sessionSecretIds: this.#secrets.sessionIds(),
        };
    }

    #appendAgentEvent(runId: string, event: AgentLoopEvent): void {
        if (this.#activeRun?.runId !== runId) {
            return;
        }

        if (event.type === "steering_applied") {
            for (const messageId of event.messageIds) {
                const pending = this.#pendingSteeringMessages.get(messageId);
                if (pending === undefined || pending.runId !== runId) continue;
                this.#storeMessage(this.#messages.length, pending.message, false, runId);
                this.#pendingSteeringMessages.delete(messageId);
            }
            this.#append("steering_applied", { messageIds: event.messageIds, runId });
            return;
        }

        if (event.type === "inference_iteration_start") {
            this.#activePartial = {
                fallbackId: `${runId}:assistant:${event.iteration}`,
                position: undefined,
                runId,
            };
        } else if (event.type === "context_compacted") {
            this.#totalTokens = event.estimatedTokensAfter;
        } else if ("partial" in event) {
            this.#storePartialMessage(runId, event.partial);
        }

        this.#append("agent_event", { event, runId });
        if (event.type === "context_compacted" && this.isSubagent()) {
            this.#agentManager?.recordChanged(this);
        }
    }

    #appendCompactionAgentEvent(runId: string, event: AgentLoopEvent): void {
        if (!this.#compactionActive) return;
        if (event.type === "context_compacted") this.#totalTokens = event.estimatedTokensAfter;
        this.#append("agent_event", { event, runId });
    }

    #appendAgentMessage(runId: string, message: Message): void {
        if (this.#activeRun?.runId !== runId) {
            return;
        }

        const existingMessage = this.#messages.find(
            (candidate) => !candidate.isPartial && candidate.message.id === message.id,
        );
        const previousUsage =
            existingMessage?.message.role === "agent" ? existingMessage.message.usage : undefined;
        const existingPosition = existingMessage?.position;
        const partialPosition =
            message.role === "agent" && this.#activePartial?.runId === runId
                ? this.#activePartial.position
                : undefined;
        this.#storeMessage(
            existingPosition ?? partialPosition ?? this.#messages.length,
            message,
            false,
            runId,
        );
        if (message.role === "agent") {
            const resultIds = new Set(
                message.blocks.flatMap((block) =>
                    block.type === "tool_result" ? [block.toolCallId] : [],
                ),
            );
            for (const call of this.#externalToolCalls.values()) {
                if (call.runId !== runId || !resultIds.has(call.toolCallId)) continue;
                call.consumed = true;
                this.#persistence?.upsertExternalToolCall?.(call);
            }
            for (const call of this.#durableUserInputs.values()) {
                if (call.runId !== runId || !resultIds.has(call.toolCallId)) continue;
                const result = message.blocks.find(
                    (block): block is ToolResultBlock =>
                        block.type === "tool_result" && block.toolCallId === call.toolCallId,
                );
                if (result !== undefined) call.result = structuredClone(result);
                call.status = "completed";
                call.consumed = true;
                call.resolvedAt ??= this.#now();
                this.#persistence?.upsertDurableUserInput?.(call);
            }
            this.#pruneExternalToolCalls();
            this.#pruneDurableUserInputs();
        }
        if (partialPosition !== undefined) {
            this.#activePartial = undefined;
        }
        if (message.role === "agent" && message.usage !== undefined) {
            this.#totalTokens = message.usage.totalTokens;
        }
        const nextUsage = message.role === "agent" ? message.usage : undefined;
        if (!isDeepStrictEqual(previousUsage, nextUsage)) {
            this.#usage =
                previousUsage === undefined && nextUsage !== undefined
                    ? addUsage(this.#usage, nextUsage)
                    : this.#sumCommittedUsage();
        }
        this.#append("agent_message", { message, runId });
        if (this.isSubagent()) this.#agentManager?.recordChanged(this);
    }

    #sumCommittedUsage(): Usage {
        return this.#messages.reduce(
            (total, persisted) =>
                !persisted.isPartial &&
                persisted.message.role === "agent" &&
                persisted.message.usage !== undefined
                    ? addUsage(total, persisted.message.usage)
                    : total,
            zeroUsage(),
        );
    }

    #appendRunFinished(runId: string, result: AgentRunResult): SessionRunCompletion["status"] {
        const stopReason: StopReason = result.stopReason;
        const responseText = findLastAgentResponseText(
            this.#messages.filter((entry) => entry.runId === runId).map((entry) => entry.message),
        );
        const providerFailed = this.isSubagent() && stopReason === "error";
        const tokenExhausted =
            this.isSubagent() &&
            stopReason !== "aborted" &&
            stopReason !== "error" &&
            responseText === undefined;
        const subagentFailed = providerFailed || tokenExhausted;
        if (!this.#workspaceArchived) {
            this.#status = subagentFailed
                ? "error"
                : stopReason === "aborted"
                  ? this.#suspendOnAbort
                      ? "suspended"
                      : "aborted"
                  : "completed";
        }
        this.#finishElapsedInterval();
        this.#suspendOnAbort = false;
        this.#activePartial = undefined;
        if (this.#activeRun?.runId === runId) {
            this.#activeRun = undefined;
        }
        this.#discardPendingSteeringMessages(runId);
        if (subagentFailed) {
            this.#pauseActiveGoal();
            this.#append("run_error", {
                errorMessage: providerFailed
                    ? (result.errorMessage ?? "The model response failed.")
                    : SUBAGENT_TOKEN_EXHAUSTED_ERROR,
                modelLocked: this.#modelLocked(),
                runId,
            });
            this.#restartMetadataSettlement();
            this.#agentManager?.recordChanged(this);
            return "error";
        }
        this.#append("run_finished", {
            agentRunId: result.runId,
            ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
            modelLocked: this.#modelLocked(),
            runId,
            stopReason,
        });
        if (stopReason !== "aborted" && stopReason !== "error") {
            this.#agentManager?.recordSuccessfulProvider?.(this.#modelId, this.#providerId);
        }
        this.#restartMetadataSettlement();
        if (this.isSubagent()) this.#agentManager?.recordChanged(this);
        return stopReason === "aborted" ? "aborted" : "completed";
    }

    async #observeProviderQuota(
        provider: Provider,
        runId: string,
        observationId: string,
        phase: "before" | "after",
    ): Promise<void> {
        if (this.isSubagent() || provider.quota === undefined) return;
        try {
            const quota = await provider.quota({ fresh: true });
            this.#append("provider_quota_observed", {
                observationId,
                phase,
                providerId: provider.id,
                quota,
                runId,
            });
        } catch {
            // Quota observation must never fail or replay an otherwise completed agent run.
        }
    }

    #finishElapsedInterval(): void {
        if (this.#activeSince === undefined) return;
        this.#elapsedMs += Math.max(0, this.#now() - this.#activeSince);
        this.#activeSince = undefined;
    }

    #committedMessages(): Message[] {
        return this.#messages
            .filter((message) => !message.isPartial)
            .sort((left, right) => left.position - right.position)
            .map((message) => message.message);
    }

    #discardPendingSteeringMessages(runId: string): void {
        for (const [messageId, pending] of this.#pendingSteeringMessages) {
            if (pending.runId === runId) this.#pendingSteeringMessages.delete(messageId);
        }
    }

    #ensureKnownModel(modelId: string, providerId: string): Model {
        const model = this.#modelsForProvider(providerId).find(
            (candidate) => candidate.id === modelId,
        );
        if (model === undefined) {
            throw new Error(`Unknown model '${modelId}' for provider '${providerId}'.`);
        }
        return model;
    }

    #ensureRuntime(): CodingAssistantRuntime {
        if (this.#runtime !== undefined) {
            return this.#runtime;
        }

        const agentManager = this.#agentManager;
        const options: CreateCodingAssistantAgentOptions = {
            agentId: this.#agentId,
            ...(this.#appendSystemPrompt !== undefined
                ? { appendSystemPrompt: this.#appendSystemPrompt }
                : {}),
            cwd: this.#request.cwd,
            ...(this.#executor === undefined ? {} : { executor: this.#executor }),
            ...(agentManager === undefined
                ? {}
                : {
                      chatHistory: {
                          read: (historyOptions) =>
                              agentManager.readChatHistory(this.id, historyOptions),
                      },
                  }),
            messages: this.#contextMessages ?? this.#committedMessages(),
            modelId: this.#modelId,
            permissionMode: this.#permissionMode,
            providerId: this.#providerId,
            secrets: this.#secrets,
            userInput: {
                markExecuting: (requestId) => this.markUserInputExecuting(requestId),
                request: (request, requestOptions) =>
                    this.requestUserInput(request, requestOptions),
            },
            sessionId: this.#agentMetadata.rootSessionId,
            startDate: toLocalDate(
                this.events.firstMessageCreatedAt() ?? this.events.firstCreatedAt() ?? this.#now(),
            ),
            ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
            ...(this.#durableSkillDefinitions.length === 0
                ? {}
                : { durableSkills: this.#durableSkillDefinitions }),
            tasks: {
                create: (request) => this.#taskSession().createTask(request),
                get: (taskId) => this.#taskSession().getTask(taskId),
                list: () => this.#taskSession().listTasks(),
                update: (taskId, request) => this.#taskSession().updateTask(taskId, request),
            },
        };
        if (this.#workflowsEnabled) {
            options.workflowsEnabled = true;
            options.workflows = {
                get: (runId) => this.getWorkflow(runId),
                launch: (request) => this.launchWorkflow(request),
                stop: (runId) => this.stopWorkflow(runId),
                wait: (runId, signal) => this.waitForWorkflow(runId, signal),
            };
        } else {
            options.workflowsEnabled = false;
        }
        if (!this.isSubagent()) {
            options.goals = {
                create: (request) => this.setGoal(request),
                get: () => this.goal(),
                update: (status) => this.changeGoalStatus({ status }, { stopActiveGoalRun: false }),
            };
        }
        if (this.#contextMessages !== undefined) {
            options.contextMessages = this.#contextMessages;
        }
        if (this.#effort !== undefined) options.effort = this.#effort;
        if (this.#serviceTier !== undefined) options.serviceTier = this.#serviceTier;
        if (this.#instructions !== undefined) options.instructions = this.#instructions;
        if (this.#request.apiKey !== undefined) options.apiKey = this.#request.apiKey;
        if (this.#request.docker !== undefined) options.docker = this.#request.docker;
        if (agentManager !== undefined) {
            options.subagents = {
                availableModels: this.#modelCatalog.providers.flatMap((provider) =>
                    provider.models.map((model) => ({
                        defaultEffort: model.defaultThinkingLevel,
                        effortLevels: model.thinkingLevels,
                        id: model.id,
                        name: model.name,
                        providerId: provider.providerId,
                    })),
                ),
                canSpawn: this.#agentMetadata.depth < agentManager.maxDepth,
                depth: this.#agentMetadata.depth,
                disabledProviders: this.#modelCatalog.providers.flatMap((provider) =>
                    provider.disabledReason === undefined
                        ? []
                        : [{ id: provider.providerId, reason: provider.disabledReason }],
                ),
                encryptedMessages: false,
                followUp: (target, message, effort, encryptedMessage) =>
                    agentManager.followUp(this.id, target, message, effort, encryptedMessage),
                inspect: (target) => agentManager.inspect(this.id, target),
                interrupt: (target) => agentManager.interrupt(this.id, target),
                list: (pathPrefix) => agentManager.list(this.id, pathPrefix),
                maxActive:
                    (agentManager.maxActiveFor?.(this.#agentMetadata.rootSessionId) ??
                        agentManager.maxActive) + 1,
                maxDepth: agentManager.maxDepth,
                sendMessage: (target, message, encryptedMessage) =>
                    agentManager.sendMessage(this.id, target, message, encryptedMessage),
                spawn: (request, signal) => agentManager.spawn(this.id, request, signal),
                wait: (timeoutMs, signal) => agentManager.wait(this.id, timeoutMs, signal),
            };
        }
        const runtime = this.#createRuntime(options);
        if (runtime.context.subagents !== undefined) {
            runtime.context.subagents.encryptedMessages =
                createEncryptedAgentTransportScope(runtime.executor, runtime.agent.model) !==
                undefined;
        }
        this.#externalToolInstallation = { installed: new Set(), shadowed: new Map() };
        this.#installExternalTools(runtime);
        let previousBackgroundCount = runtime.context.bash.activeSessionCount?.() ?? 0;
        runtime.context.bash.setActiveSessionCountListener?.((running) => {
            const runId = this.#activeRun?.runId ?? this.#lastSessionRunId ?? "background";
            this.#append("agent_event", {
                event: {
                    type: "background_processes_changed",
                    processes: runtime.context.bash.activeSessions?.() ?? [],
                    running,
                },
                runId,
            });
            if (running === previousBackgroundCount) return;
            previousBackgroundCount = running;
            this.#restartMetadataSettlement();
        });
        const snapshot = runtime.agent.snapshot();
        this.#runtime = runtime;
        this.#agentId = snapshot.id;
        this.#appendSystemPrompt = snapshot.appendSystemPrompt;
        this.#providerId = runtime.executor.id;
        this.#modelId = snapshot.modelId;
        this.#effort = snapshot.effort;
        this.#serviceTier = snapshot.serviceTier;
        this.#instructions = snapshot.instructions;
        this.#systemPrompt = snapshot.systemPrompt;
        this.#models = this.#modelsForProvider(this.#providerId);
        this.#tools = snapshot.tools;
        this.#saveSession();
        return runtime;
    }

    #applyIntegrationConfiguration(queued: PersistedQueuedRun): void {
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(queued, "systemPrompt")) {
            this.#systemPrompt = queued.systemPrompt ?? undefined;
            this.#runtime?.agent.setSystemPrompt(this.#systemPrompt);
            changed = true;
        }
        if (queued.externalTools !== undefined) {
            this.#externalToolDefinitions = queued.externalTools.map((definition) => ({
                ...definition,
            }));
            if (this.#runtime !== undefined) this.#installExternalTools(this.#runtime);
            changed = true;
        }
        if (queued.skills !== undefined) {
            this.#durableSkillDefinitions = queued.skills.map((definition) => ({ ...definition }));
            this.#runtime?.agent.setDurableSkills(this.#durableSkillDefinitions);
            if (this.#runtime !== undefined) this.#installExternalTools(this.#runtime);
            changed = true;
        }
        if (changed) this.#append("session_updated", { session: this.snapshot() });
        else this.#saveSession();
    }

    #installExternalTools(runtime: CodingAssistantRuntime): void {
        const externalTools = this.#externalToolDefinitions.map((definition) =>
            createExternalTool({
                definition,
                invoke: (request, signal) => this.#invokeExternalTool(definition, request, signal),
            }),
        );
        if (this.#durableSkillDefinitions.length > 0) {
            externalTools.push(
                createDurableSkillTool({
                    skills: this.#durableSkillDefinitions,
                    invoke: (skill, request, signal) =>
                        this.#invokeExternalTool(
                            {
                                description: `Read the complete SKILL.md for ${skill.name}.`,
                                label: "Read skill",
                                name: "read_skill",
                                parameters: {
                                    additionalProperties: false,
                                    properties: { name: { type: "string" } },
                                    required: ["name"],
                                    type: "object",
                                },
                            },
                            request,
                            signal,
                            skill,
                        ),
                }),
            );
        }
        const replacement = replaceExternalTools(
            runtime.agent.tools,
            externalTools,
            this.#externalToolInstallation,
        );
        runtime.agent.setTools(replacement.tools);
        this.#externalToolInstallation = replacement.installation;
        this.#tools = runtime.agent.tools.map((tool) => tool.name);
    }

    #taskSession(): InMemorySession {
        return this.#agentManager?.taskSession(this.id) ?? this;
    }

    #activeProcessCount(): number {
        const runtime = this.#runtime;
        const nativeProcesses = runtime?.processManager.activeCount() ?? 0;
        return this.#request.docker === undefined
            ? nativeProcesses
            : nativeProcesses + (runtime?.context.bash.activeSessionCount?.() ?? 0);
    }

    async #killRuntimeProcesses(forceAfterMs = 500): Promise<void> {
        const runtime = this.#runtime;
        if (runtime === undefined) return;
        await runtime.processManager.killAll({ forceAfterMs });
        if (this.#request.docker !== undefined) await runtime.context.bash.killAllSessions?.();
    }

    async #drainQueue(): Promise<void> {
        for (;;) {
            const queued = this.#queue.shift();
            if (queued === undefined) {
                if (this.#status === "queued" || this.#status === "running") {
                    this.#status = "idle";
                }
                this.#saveSession();
                return;
            }

            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
            await this.#runQueued(queued);
        }
    }

    #saveSession(): void {
        if (this.#workspaceArchived) this.#status = "archived";
        this.#persistence?.saveSession(this.state());
    }

    #separateModelContextFromVisibleTranscript(): void {
        if (this.#contextMessages !== undefined) return;

        const runtimeSnapshot = this.#runtime?.agent.snapshot();
        this.#contextMessages = [
            ...(runtimeSnapshot?.contextMessages ??
                runtimeSnapshot?.messages ??
                this.#committedMessages()),
        ];
    }

    #completionForRun(runId: string): SessionRunCompletion | undefined {
        const events = this.events.since(undefined) ?? [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (
                event === undefined ||
                (event.type !== "run_finished" && event.type !== "run_error") ||
                event.data.runId !== runId
            ) {
                continue;
            }
            if (event.type === "run_error") {
                return { errorMessage: event.data.errorMessage, status: "error" };
            }
            return {
                status: event.data.stopReason === "aborted" ? "aborted" : "completed",
            };
        }
        return undefined;
    }

    #modelLocked(): boolean {
        return this.#activeRun !== undefined || this.#queue.length > 0;
    }

    #selectedModel(): Model {
        const model = this.#models.find((candidate) => candidate.id === this.#modelId);
        if (model === undefined) {
            throw new Error(`Unknown model '${this.#modelId}' for provider '${this.#providerId}'.`);
        }
        return model;
    }

    #modelsForProvider(providerId: string): readonly Model[] {
        return (
            this.#modelCatalog.providers.find((provider) => provider.providerId === providerId)
                ?.models ?? []
        );
    }

    #providerSupportsServiceTier(providerId: string, serviceTier: ServiceTier): boolean {
        return (
            this.#modelCatalog.providers
                .find((provider) => provider.providerId === providerId)
                ?.serviceTiers?.includes(serviceTier) === true
        );
    }

    #clearMetadataSettlement(): void {
        this.#metadataRevision += 1;
        this.#metadataController?.abort();
        this.#metadataController = undefined;
        if (this.#titleStatus === "generating") {
            this.#titleStatus = this.#title === undefined ? "idle" : "ready";
            this.#titleError = undefined;
            this.#saveSession();
        }
    }

    #invalidateSessionMetadata(): void {
        this.#clearMetadataSettlement();
        this.#metadataInitialAttempted = false;
        this.#metadataRefinementAttempted = false;
        this.#metadataRunId = undefined;
        this.#metadataUpdatedAt = undefined;
        this.#recap = undefined;
        this.#title = this.#agentMetadata.description;
        this.#titleError = undefined;
        this.#titleStatus = this.#title === undefined ? "idle" : "ready";
    }

    #restartMetadataSettlement(): void {
        if (this.#closing || this.#taskDrain?.closing === true) return;
        if (this.isSubagent()) {
            this.#agentManager?.recordDescendantSettlementActivity(
                this.#agentMetadata.rootSessionId,
            );
            return;
        }
        if (this.#metadataController !== undefined) {
            return;
        }
        const target = this.#metadataGenerationTarget();
        if (target === undefined) return;
        if (target.kind === "initial") this.#metadataInitialAttempted = true;
        else this.#metadataRefinementAttempted = true;
        const revision = this.#metadataRevision;
        const settle = () => this.#settleMetadata(revision, target);
        const settlement = this.#taskDrain?.run(settle) ?? settle();
        void settlement.catch(() => undefined);
    }

    #metadataGenerationTarget(): MetadataGenerationTarget | undefined {
        if (this.#metadataRunId !== undefined || this.#titleStatus === "error") return undefined;
        const submittedRunIds = new Set(
            (this.events.since(undefined) ?? []).flatMap((event) =>
                event.type === "message_submitted" ? [event.data.runId] : [],
            ),
        );
        const realUsers = this.#messages.filter(
            (entry) =>
                !entry.isPartial &&
                entry.runId !== undefined &&
                submittedRunIds.has(entry.runId) &&
                entry.message.role === "user" &&
                entry.message.provenance !== "agent",
        );
        const first = realUsers[0];
        if (first?.runId === undefined) return undefined;
        if (!this.#metadataInitialAttempted) {
            return { kind: "initial", runId: first.runId };
        }
        if (this.#metadataRefinementAttempted) return undefined;
        const second = realUsers[1];
        if (second?.runId !== undefined) {
            return { kind: "refined", runId: second.runId };
        }
        const firstResponse = findLastAgentResponseText(
            this.#messages
                .filter(
                    (entry) =>
                        !entry.isPartial &&
                        entry.runId === first.runId &&
                        entry.message.role === "agent",
                )
                .map((entry) => entry.message),
        );
        return firstResponse === undefined ? undefined : { kind: "refined", runId: first.runId };
    }

    async #settleMetadata(revision: number, target: MetadataGenerationTarget): Promise<void> {
        const transcript = createSessionMetadataTranscript(
            this.#messages,
            this.events.since(undefined) ?? [],
            target.kind === "initial" ? { initial: true } : {},
        );
        if (revision !== this.#metadataRevision || transcript === undefined || this.#closing) {
            return;
        }

        const controller = new AbortController();
        let completed = false;
        this.#metadataController = controller;
        this.#titleStatus = "generating";
        this.#titleError = undefined;
        this.#append("session_title_changed", { status: this.#titleStatus });
        try {
            const metadata = await generateSessionMetadata({
                ...(this.#title === undefined ? {} : { currentTitle: this.#title }),
                now: this.#now,
                provider: this.#ensureRuntime().executor,
                sessionId: this.id,
                signal: controller.signal,
                startDate: toLocalDate(
                    this.events.firstMessageCreatedAt() ??
                        this.events.firstCreatedAt() ??
                        this.#now(),
                ),
                transcript,
            });
            if (controller.signal.aborted || revision !== this.#metadataRevision || this.#closing) {
                return;
            }
            const metadataUpdatedAt = this.#now();
            this.#title = metadata.title;
            this.#recap = metadata.recap;
            this.#metadataRunId = target.kind === "refined" ? target.runId : undefined;
            this.#metadataUpdatedAt = metadataUpdatedAt;
            this.#titleStatus = "ready";
            this.#titleError = undefined;
            this.#append("session_title_changed", {
                ...(this.#metadataRunId === undefined
                    ? {}
                    : { metadataRunId: this.#metadataRunId }),
                metadataUpdatedAt,
                recap: metadata.recap,
                status: this.#titleStatus,
                title: metadata.title,
            });
            if (target.kind === "initial" && this.#workspaceId !== undefined) {
                try {
                    this.#onInitialTitle?.({
                        projectId: this.#projectId,
                        sessionId: this.id,
                        title: metadata.title,
                        workspaceId: this.#workspaceId,
                    });
                } catch {
                    // Workspace title inheritance is optional enrichment and cannot fail the chat.
                }
            }
            completed = true;
        } catch (error) {
            if (controller.signal.aborted || revision !== this.#metadataRevision) return;
            this.#titleStatus = "error";
            this.#titleError = errorToMessage(error);
            this.#append("session_title_changed", {
                errorMessage: this.#titleError,
                status: this.#titleStatus,
            });
        } finally {
            if (this.#metadataController === controller) this.#metadataController = undefined;
            if (completed) queueMicrotask(() => this.#restartMetadataSettlement());
        }
    }

    async #runQueued(queued: PersistedQueuedRun): Promise<void> {
        let controller = new AbortController();
        const debugLog = this.#debugLogFor(queued);
        this.#activeRun = {
            controller,
            debug: queued.debug === true,
            kind: queued.kind,
            runId: queued.runId,
        };
        this.#lastSessionRunId = queued.runId;
        this.#restoredActiveRunId = undefined;
        this.#status = "running";
        this.#activeSince ??= this.#now();
        this.#append("run_started", { runId: queued.runId });
        if (this.isSubagent()) this.#agentManager?.recordChanged(this);

        let runtime: CodingAssistantRuntime | undefined;
        const quotaObservationId = createId();
        try {
            // The configuration applies before anything can await, so a run leaves the queue and
            // takes effect in one step. Nothing else can observe a started run still describing
            // itself with the configuration it is replacing.
            if (
                queued.effort !== undefined ||
                queued.modelId !== undefined ||
                queued.serviceTier !== undefined
            ) {
                // The message and the configuration it carried arrive together, so the run this
                // starts is the first one the new configuration applies to.
                this.#applyConfiguration(
                    {
                        ...(queued.effort === undefined ? {} : { effort: queued.effort }),
                        ...(queued.modelId === undefined ? {} : { modelId: queued.modelId }),
                        ...(queued.providerId === undefined
                            ? {}
                            : { providerId: queued.providerId }),
                        ...(queued.serviceTier === undefined
                            ? {}
                            : { serviceTier: queued.serviceTier }),
                    },
                    { excludeRunId: queued.runId },
                );
            }
            this.#applyIntegrationConfiguration(queued);
            await debugLog?.record("run-started", {
                runId: queued.runId,
                sessionId: this.id,
            });
            runtime = this.#ensureRuntime();
            await this.#ensureMcpTools(runtime, controller.signal, queued.interactive !== false);
            await this.#observeProviderQuota(
                runtime.executor,
                queued.runId,
                quotaObservationId,
                "before",
            );
            runtime.agent.enqueueMessage(queued.userMessage);
            if (this.#contextMessages !== undefined) {
                this.#contextMessages = [...this.#contextMessages, queued.userMessage];
                this.#saveSession();
            }
            for (;;) {
                const result = await runtime.agent.run({
                    ...(debugLog === undefined ? {} : { debug: debugLog }),
                    signal: controller.signal,
                    onEvent: async (event) => {
                        this.#appendAgentEvent(queued.runId, event);
                        await debugLog?.record("agent-event", { event, runId: queued.runId });
                    },
                    onMessage: async (message) => {
                        this.#appendAgentMessage(queued.runId, message);
                        await debugLog?.record("agent-message", { message, runId: queued.runId });
                    },
                });
                if (this.#activeRun?.runId !== queued.runId) {
                    return;
                }
                await debugLog?.record("run-finished", {
                    agentRunId: result.runId,
                    runId: queued.runId,
                    stopReason: result.stopReason,
                });

                const continuation = this.#pendingSteeringContinuations.get(queued.runId);
                if (result.stopReason === "aborted" && continuation !== undefined) {
                    await continuation.ready;
                    if (
                        !continuation.cancelled &&
                        this.#pendingSteeringContinuations.get(queued.runId) === continuation &&
                        this.#activeRun?.runId === queued.runId
                    ) {
                        this.#pendingSteeringContinuations.delete(queued.runId);
                        controller = new AbortController();
                        this.#activeRun = {
                            controller,
                            debug: queued.debug === true,
                            kind: queued.kind,
                            runId: queued.runId,
                        };
                        this.#activePartial = undefined;
                        continue;
                    }
                    this.#pendingSteeringContinuations.delete(queued.runId);
                }

                await this.#observeProviderQuota(
                    runtime.executor,
                    queued.runId,
                    quotaObservationId,
                    "after",
                );
                const completionStatus = this.#appendRunFinished(queued.runId, result);
                if (completionStatus === "completed" && result.stopReason !== "error") {
                    this.#continueGoalIfIdle();
                }
                break;
            }
        } catch (error) {
            if (this.#activeRun?.runId !== queued.runId) {
                return;
            }
            if (!this.#workspaceArchived) {
                this.#status =
                    controller.signal.aborted && this.#suspendOnAbort ? "suspended" : "error";
            }
            this.#finishElapsedInterval();
            this.#suspendOnAbort = false;
            this.#activePartial = undefined;
            this.#discardPendingSteeringMessages(queued.runId);
            this.#pauseActiveGoal();
            if (this.#activeRun?.runId === queued.runId) {
                this.#activeRun = undefined;
            }
            if (runtime !== undefined) {
                await this.#observeProviderQuota(
                    runtime.executor,
                    queued.runId,
                    quotaObservationId,
                    "after",
                );
            }
            await debugLog
                ?.record("run-error", { error, runId: queued.runId, sessionId: this.id })
                .catch(() => undefined);
            this.#append("run_error", {
                errorMessage: errorToMessage(error),
                modelLocked: this.#modelLocked(),
                runId: queued.runId,
            });
            this.#restartMetadataSettlement();
            if (this.isSubagent()) this.#agentManager?.recordChanged(this);
        } finally {
            this.#pendingSteeringContinuations.delete(queued.runId);
            if (this.#activeRun?.runId === queued.runId) {
                this.#activeRun = undefined;
            }
            if (this.#restoredActiveRunId === queued.runId && this.hasDurableToolRun()) {
                this.#contextMessages = undefined;
                void this.#runtime?.agent.close();
                this.#runtime = undefined;
            } else {
                this.#syncContextMessages();
            }
            this.#saveSession();
            await this.#closeDebugLog(queued);
        }
    }

    async #closeDebugLog(queued: PersistedQueuedRun): Promise<void> {
        const debugLog = this.#debugLogFor(queued);
        if (debugLog === undefined) return;
        await debugLog.flush().catch(() => undefined);
        if (this.#debugLogs.get(queued.runId) === debugLog) {
            this.#debugLogs.delete(queued.runId);
        }
    }

    #debugLogFor(queued: PersistedQueuedRun): DebugLog | undefined {
        if (queued.debug !== true || queued.debugDirectory === undefined) return undefined;
        const existing = this.#debugLogs.get(queued.runId);
        if (existing !== undefined) return existing;
        const created = new DebugLog({ directory: queued.debugDirectory, now: this.#now });
        this.#debugLogs.set(queued.runId, created);
        return created;
    }

    #syncContextMessages(): void {
        const snapshot = this.#runtime?.agent.snapshot();
        if (snapshot !== undefined) {
            this.#contextMessages = [...(snapshot.contextMessages ?? snapshot.messages)];
        }
    }

    #startDrainQueue(): void {
        if (this.#draining !== undefined) {
            return;
        }

        const drain = () => this.#drainQueue();
        const draining = this.#taskDrain?.run(drain) ?? drain();
        this.#draining = draining.finally(() => {
            this.#draining = undefined;
        });
        void this.#draining.catch(() => undefined);
    }

    #assertAcceptingWork(): void {
        if (this.#workspaceArchived) {
            throw new Error("This session was archived with its workspace.");
        }
        if (this.#closing || this.#taskDrain?.closing === true) {
            throw new Error("The local daemon is shutting down.");
        }
    }

    #assertSupportedEffort(effort: string): void {
        this.#assertSupportedEffortForModel(effort, this.#selectedModel());
    }

    /**
     * Rejects a message whose configuration could never apply, so the caller learns immediately
     * rather than discovering it when the run finally starts.
     *
     * Effort is checked against the model this message will actually run on, which is the one it
     * carries, or the one an earlier queued message already selected, not necessarily the model
     * selected right now. This cannot be perfectly airtight, because a queued run can outlive a
     * restart that changes the catalog, so applying it later stays fallible too.
     */
    #assertConfigurationCanApply(request: SessionSubmitMessageRequest): void {
        const pendingModel = [...this.#queue]
            .reverse()
            .find((queued) => queued.modelId !== undefined);
        const modelId = request.modelId ?? pendingModel?.modelId;
        const providerId =
            request.modelId === undefined ? pendingModel?.providerId : request.providerId;
        const model =
            modelId === undefined
                ? this.#selectedModel()
                : this.#ensureKnownModel(
                      modelId,
                      this.#resolveProviderForModel(modelId, providerId),
                  );
        if (request.effort !== undefined) {
            this.#assertSupportedEffortForModel(request.effort, model);
        }
        if (
            request.serviceTier !== undefined &&
            request.serviceTier !== null &&
            !this.#providerSupportsServiceTier(
                modelId === undefined
                    ? this.#providerId
                    : this.#resolveProviderForModel(modelId, providerId),
                request.serviceTier,
            )
        ) {
            throw new Error("That provider does not support fast inference.");
        }
    }

    #assertSupportedEffortForModel(effort: string, model: Model): void {
        if (!model.thinkingLevels.includes(effort)) {
            throw new Error(`Model '${model.id}' does not support '${effort}' reasoning.`);
        }
    }

    /**
     * The committed transcript, optionally without one run's messages. A run that has been queued
     * but not yet sent has already stored its message, and that message belongs to whatever model
     * is about to receive it rather than to the history of the model being replaced.
     */
    #committedMessagesExcludingRun(runId: string | undefined): Message[] {
        return this.#messages
            .filter(
                (message) => !message.isPartial && (runId === undefined || message.runId !== runId),
            )
            .sort((left, right) => left.position - right.position)
            .map((message) => message.message);
    }

    #continueGoalIfIdle(): void {
        if (
            this.#closing ||
            this.#taskDrain?.closing === true ||
            this.isSubagent() ||
            this.#goal?.status !== "active" ||
            this.#restoredActiveRunId !== undefined ||
            this.#status === "running" ||
            this.#activeRun !== undefined ||
            this.#queue.length > 0
        ) {
            return;
        }

        const runId = createId();
        const text = createGoalContinuationPrompt(this.#goal);
        const userMessage: UserMessage = {
            blocks: [{ type: "text", text }],
            id: createId(),
            role: "user",
        };
        const queued: PersistedQueuedRun = {
            displayText: "Continuing active goal",
            kind: "goal",
            runId,
            text,
            userMessage,
        };
        this.#queue.push(queued);
        this.#persistence?.insertQueuedRun(this.id, queued);
        this.#status = "queued";
        this.#saveSession();
        this.#startDrainQueue();
    }

    #discardQueuedGoalRuns(): void {
        const discardedQueue = this.#queue.filter((queued) => queued.kind === "goal");
        if (discardedQueue.length === 0) return;

        this.#queue = this.#queue.filter((queued) => queued.kind !== "goal");
        for (const queued of discardedQueue) {
            this.#persistence?.deleteQueuedRun(this.id, queued.runId);
        }
        void Promise.all(discardedQueue.map((queued) => this.#closeDebugLog(queued)));
        if (this.#activeRun === undefined && this.#queue.length === 0) this.#status = "idle";
        this.#saveSession();
    }

    #pauseActiveGoal(): void {
        if (this.#goal?.status !== "active") return;
        this.#goal = { ...this.#goal, status: "paused", updatedAt: this.#now() };
        this.#append("goal_changed", { goal: { ...this.#goal } });
    }

    #storeMessage(position: number, message: Message, isPartial: boolean, runId: string): void {
        const replaced = this.#messages.find((candidate) => candidate.position === position);
        if (replaced?.message.role === "user") {
            this.#submittedUserMessages.delete(replaced.message.id);
        }
        const entry: PersistedSessionMessage = {
            isPartial,
            message,
            position,
            runId,
        };
        this.#messages = [
            ...this.#messages.filter((candidate) => candidate.position !== position),
            entry,
        ].sort((left, right) => left.position - right.position);
        if (isPartial) {
            this.#partialPositions.add(position);
        } else {
            this.#partialPositions.delete(position);
        }
        if (message.role === "user") this.#submittedUserMessages.set(message.id, entry);
        this.#persistence?.upsertMessage(this.id, entry);
    }

    #storePartialMessage(
        runId: string,
        partial: Parameters<typeof assistantMessageToAgentMessage>[0],
    ): void {
        const activePartial =
            this.#activePartial?.runId === runId
                ? this.#activePartial
                : {
                      fallbackId: `${runId}:assistant`,
                      position: undefined,
                      runId,
                  };
        const position = activePartial.position ?? this.#messages.length;
        this.#activePartial = {
            ...activePartial,
            position,
        };
        const message = assistantMessageToAgentMessage(partial, () => activePartial.fallbackId, {
            providerId: this.#providerId,
            requestedModelId: this.#modelId,
        });
        this.#storeMessage(position, message, true, runId);
    }
}

function cloneWorkflowRun(run: WorkflowRun): WorkflowRun {
    return {
        ...run,
        logs: [...run.logs],
    };
}

function cloneExternalToolCall(call: ExternalToolCall): ExternalToolCall {
    return {
        ...call,
        definition: { ...call.definition, parameters: { ...call.definition.parameters } },
        ...(call.skill === undefined ? {} : { skill: { ...call.skill } }),
        ...(call.resolution === undefined
            ? {}
            : { resolution: cloneExternalResolution(call.resolution) }),
    };
}

function cloneExternalResolution(
    resolution: ExternalToolCallResolution,
): ExternalToolCallResolution {
    if (resolution.status === "failed") {
        return { status: "failed", error: { ...resolution.error } };
    }
    return {
        status: "completed",
        ...(resolution.content === undefined
            ? {}
            : { content: resolution.content.map((block) => ({ ...block })) }),
        ...(Object.prototype.hasOwnProperty.call(resolution, "output")
            ? { output: resolution.output }
            : {}),
    };
}

function limitInspectionText(text: string | undefined): string | undefined {
    if (text === undefined || text.length <= MAX_SUBAGENT_INSPECTION_TEXT_CHARS) return text;
    return `${text.slice(0, MAX_SUBAGENT_INSPECTION_TEXT_CHARS - 1)}…`;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}
