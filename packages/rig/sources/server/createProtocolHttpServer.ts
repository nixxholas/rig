import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type {
    AbortRunResponse,
    BroadcastMessageRequest,
    BroadcastMessageResponse,
    AnswerUserInputRequest,
    AttachSecretRequest,
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangePermissionModeRequest,
    ChangeServiceTierRequest,
    ChangeSessionGoalStatusRequest,
    CompactSessionResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    DaemonConfig,
    DaemonIdentity,
    DisconnectSessionTerminalResponse,
    ForkSessionResponse,
    GetCurrentProviderQuotaResponse,
    GetDaemonConfigResponse,
    GetSessionUsageResponse,
    SessionStateResponse,
    ListGlobalEventsResponse,
    ListExternalToolCallsResponse,
    ListSecretsResponse,
    HealthResponse,
    GitStateResponse,
    GitWatchResponse,
    GlobalStateResponse,
    GoalSessionResponse,
    ListModelsResponse,
    ListProjectsResponse,
    ListProjectWorkspacesResponse,
    ListSessionsResponse,
    ListSubagentsResponse,
    ModelCatalog,
    ProjectResponse,
    ProjectWorkspaceResponse,
    ReorderRequest,
    RewindSessionRequest,
    RewindSessionResponse,
    RecordSessionActivityResponse,
    ReadBackgroundProcessResponse,
    ReadSessionFileResponse,
    RunShellCommandRequest,
    RunShellCommandResponse,
    ResolveExternalToolCallRequest,
    ResolveExternalToolCallResponse,
    RegisterSecretRequest,
    RegisterSecretResponse,
    SearchFilesResponse,
    SecretSessionResponse,
    ProtocolSession,
    SessionEvent,
    SessionActivity,
    SessionArchiveResponse,
    SessionPartialMessage,
    SessionStreamHello,
    SessionTranscriptWindow,
    SessionTerminalHeartbeatRequest,
    SessionTerminalHeartbeatResponse,
    SetGoalRequest,
    ShutdownServerResponse,
    StartInspectorResponse,
    SteerMessageResponse,
    StopBackgroundProcessResponse,
    StopWorkflowResponse,
    SubagentSummary,
    SubmitMessageResponse,
    TrimGlobalEventsRequest,
    TrimGlobalEventsResponse,
    UnregisterSecretResponse,
    UpdateDaemonConfigRequest,
    UpdateDaemonConfigResponse,
    SetSessionDraftRequest,
    UpdateSessionRequest,
    WriteSessionFileRequest,
    WriteSessionFileResponse,
} from "../protocol/index.js";
import { createEventIdFactory, RIG_PROTOCOL_VERSION } from "../protocol/index.js";
import { SESSION_DRAFT_MAX_LENGTH } from "../protocol/index.js";
import { getDaemonIdentity } from "../daemon/index.js";
import { errorToMessage } from "../errorToMessage.js";
import { InMemorySessionStore } from "../session/InMemorySessionStore.js";
import type { SessionUsageSummary } from "../session/usage/index.js";
import { createModelCatalog } from "./createModelCatalog.js";
import { FileSearchService, type FileSearchServiceContract } from "./FileSearchService.js";
import type { SessionEventLog } from "../session/SessionEventLog.js";
import { isLiveOnlySessionEvent } from "../session/isLiveOnlySessionEvent.js";
import { isSubmitMessageRequest } from "./isSubmitMessageRequest.js";
import { limitProtocolSessionMessages } from "./limitProtocolSessionMessages.js";
import type { GlobalStreamHello } from "../protocol/index.js";
import type { GlobalEventQueue } from "./GlobalEventQueue.js";
import type { SessionStore } from "../session/SessionStore.js";
import { isGlobalEventRoute } from "./isGlobalEventRoute.js";
import { parseGlobalEventCursor } from "./parseGlobalEventCursor.js";
import { parseGlobalEventLimit } from "./parseGlobalEventLimit.js";
import { selectRecentSessionEvents } from "../session/selectRecentSessionEvents.js";
import { SESSION_STREAM_TURN_LIMIT } from "../protocol/index.js";
import { sendJson } from "./sendJson.js";
import { streamGlobalEvents } from "./streamGlobalEvents.js";
import { streamLiveEvents } from "./streamLiveEvents.js";
import type { GitStateTracker } from "./GitStateTracker.js";
import { resolveGitTrackedEntity } from "./resolveGitTrackedEntity.js";
import { INVALID_PERMISSION_MODE_MESSAGE, isPermissionMode } from "../permissions/index.js";
import { isGoalStatus } from "../goals/index.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { configureSessionRequest } from "../session/configureSessionRequest.js";
import {
    DEFAULT_CODEX_STREAM_MAX_RETRIES,
    MAX_CODEX_STREAM_MAX_RETRIES,
} from "../config/codexStreamRetrySettings.js";
import { SessionConfigurationError } from "../session/SessionConfigurationError.js";
import type { TaskDrain } from "./TrackedTaskDrain.js";
import type { ProviderQuota } from "@slopus/rig-providers";
import type { SecretRegistration } from "../secrets/index.js";
import type {
    CreateRemoteTerminalRequest,
    CreateRemoteTerminalResponse,
    ListRemoteTerminalsResponse,
    RemoteTerminalResponse,
    ResizeRemoteTerminalRequest,
} from "../terminal/index.js";
import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";
import { attachRemoteTerminalWebSocketServer } from "./attachRemoteTerminalWebSocketServer.js";
import { SessionTerminalTracker } from "../session/SessionTerminalTracker.js";
import { sessionSummaryWithTerminalPresence } from "../session/sessionSummaryWithTerminalPresence.js";
import { attachHttpConnectProxy } from "./attachHttpConnectProxy.js";
import {
    readSessionFile,
    SessionFileConflictError,
    SessionFileTooLargeError,
    writeSessionFile,
} from "./sessionFileApi.js";

const createTerminalSnapshotEventId = createEventIdFactory();
const createSessionSnapshotEventId = createEventIdFactory();

export interface ProtocolHttpServerOptions {
    codexStreamMaxRetries?: number;
    defaultDocker?: DockerExecutionConfig;
    gitStateTracker?: GitStateTracker;
    identity?: DaemonIdentity;
    modelCatalog?: ModelCatalog;
    fileSearchService?: FileSearchServiceContract;
    globalEventQueue?: GlobalEventQueue;
    getProviderQuota?: (providerId: string) => Promise<ProviderQuota | undefined>;
    onDaemonSettingsChange?: (
        settings: DaemonConfig["settings"],
    ) => AppliedDaemonSettings | undefined | Promise<AppliedDaemonSettings | undefined>;
    onShutdown?: () => void;
    onReloadHappy?: () => boolean | Promise<boolean>;
    onStartInspector?: () => StartInspectorResponse | Promise<StartInspectorResponse>;
    store?: SessionStore;
    taskDrain?: TaskDrain;
    secrets?: readonly SecretRegistration[];
    token: string;
}

export function createProtocolHttpServer(
    options: ProtocolHttpServerOptions,
    server: Server = createServer(),
): Server {
    const modelCatalog = options.modelCatalog ?? createModelCatalog();
    const store =
        options.store ??
        new InMemorySessionStore({
            modelCatalog,
            ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        });
    const identity = options.identity ?? getDaemonIdentity();
    const fileSearchService = options.fileSearchService ?? new FileSearchService();
    const runtimeConfig: ProtocolServerRuntimeConfig = {
        codexStreamMaxRetries: options.codexStreamMaxRetries ?? DEFAULT_CODEX_STREAM_MAX_RETRIES,
        gitStateTracker: options.gitStateTracker,
        globalEventQueue: options.globalEventQueue ?? store.globalEventQueue,
        onDaemonSettingsChange: options.onDaemonSettingsChange,
        onReloadHappy: options.onReloadHappy,
        onStartInspector: options.onStartInspector,
    };
    // The persistent store caches sessions weakly; each open SSE stream needs its own strong lease.
    const sessionEventStreamLeases = new Set<SessionEventStreamLease>();
    const sessionTerminals = new SessionTerminalTracker();

    attachRemoteTerminalWebSocketServer({ server, store, token: options.token });
    attachHttpConnectProxy(server, options.token, store);
    server.once("close", () => {
        void store.remoteTerminals.close();
    });

    server.on("request", (request, response) => {
        const mutating = isMutatingProtocolRequest(request);
        if (mutating && options.taskDrain?.closing === true) {
            sendJson(response, 503, { error: "The local daemon is shutting down." });
            return;
        }
        const handle = () =>
            handleRequest(
                request,
                response,
                store,
                modelCatalog,
                identity,
                fileSearchService,
                runtimeConfig,
                options.token,
                options.onShutdown,
                options.defaultDocker,
                options.taskDrain,
                options.getProviderQuota,
                sessionEventStreamLeases,
                sessionTerminals,
            );
        const handling =
            mutating && options.taskDrain !== undefined ? options.taskDrain.run(handle) : handle();
        void handling.catch((error: unknown) => {
            const invalidJson = error instanceof InvalidJsonBodyError;
            const bodyTooLarge = error instanceof RequestBodyTooLargeError;
            const status = bodyTooLarge
                ? 413
                : invalidJson
                  ? 400
                  : mutating && options.taskDrain?.closing === true
                    ? 503
                    : 500;
            sendJson(response, status, {
                error: bodyTooLarge
                    ? "Request body is larger than the allowed limit."
                    : invalidJson
                      ? "Request body must be valid JSON."
                      : errorToMessage(error),
            });
        });
    });
    server.once("close", () => {
        fileSearchService.close();
        sessionTerminals.dispose();
    });
    return server;
}

interface ProtocolServerRuntimeConfig {
    codexStreamMaxRetries: number;
    gitStateTracker: GitStateTracker | undefined;
    globalEventQueue: GlobalEventQueue;
    onDaemonSettingsChange: ProtocolHttpServerOptions["onDaemonSettingsChange"];
    onStartInspector: (() => StartInspectorResponse | Promise<StartInspectorResponse>) | undefined;
    onReloadHappy: (() => boolean | Promise<boolean>) | undefined;
}

interface AppliedDaemonSettings {
    codexStreamMaxRetries: number;
    globalEventQueue: GlobalEventQueue;
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    store: SessionStore,
    modelCatalog: ModelCatalog,
    identity: DaemonIdentity,
    fileSearchService: FileSearchServiceContract,
    runtimeConfig: ProtocolServerRuntimeConfig,
    token: string,
    onShutdown: (() => void) | undefined,
    defaultDocker: DockerExecutionConfig | undefined,
    taskDrain: TaskDrain | undefined,
    getProviderQuota: ((providerId: string) => Promise<ProviderQuota | undefined>) | undefined,
    sessionEventStreamLeases: Set<SessionEventStreamLease>,
    sessionTerminals: SessionTerminalTracker,
): Promise<void> {
    if (!isAuthorizedProtocolRequest(request, token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
    }

    const url = new URL(request.url ?? "/", "http://unix");
    const route = matchRoute(url.pathname);
    if (route === undefined) {
        sendJson(response, 404, { error: "Not found" });
        return;
    }

    if (request.method === "GET" && route.name === "health") {
        sendJson<HealthResponse>(
            response,
            200,
            healthResponse(modelCatalog, identity, runtimeConfig.globalEventQueue.durable),
        );
        return;
    }

    if (request.method === "POST" && route.name === "shutdown") {
        taskDrain?.beginClose();
        sendJson<ShutdownServerResponse>(response, 202, {
            pid: process.pid,
            shuttingDown: true,
        });
        setImmediate(() => onShutdown?.());
        return;
    }

    if (request.method === "POST" && route.name === "debug-inspector") {
        if (runtimeConfig.onStartInspector === undefined) {
            sendJson(response, 409, { error: "This daemon cannot start a debugger." });
            return;
        }
        sendJson<StartInspectorResponse>(response, 200, await runtimeConfig.onStartInspector());
        return;
    }

    if (request.method === "POST" && route.name === "happy-reload") {
        if (runtimeConfig.onReloadHappy === undefined) {
            sendJson(response, 409, { error: "This daemon cannot reload Happy credentials." });
            return;
        }
        sendJson(response, 200, { enabled: await runtimeConfig.onReloadHappy() });
        return;
    }

    if (request.method === "GET" && route.name === "models") {
        sendJson<ListModelsResponse>(response, 200, { catalog: modelCatalog });
        return;
    }

    if (request.method === "GET" && route.name === "state") {
        const sessions = store.list({ limit: 501 });
        sendJson<GlobalStateResponse>(response, 200, {
            cursor: runtimeConfig.globalEventQueue.cursor(),
            gitSnapshots: runtimeConfig.gitStateTracker?.liveSnapshots() ?? [],
            hasMoreSessions: sessions.length > 500,
            projects: store.listProjects(),
            sessions: sessions
                .slice(0, 500)
                .map((summary) => sessionSummaryWithTerminalPresence(summary, sessionTerminals)),
            workspaces: store.listWorkspaces(),
        });
        return;
    }

    if (request.method === "GET" && route.name === "projects") {
        sendJson<ListProjectsResponse>(response, 200, { projects: store.listProjects() });
        return;
    }

    if (route.name === "project-terminals" || route.name === "project-terminal") {
        const scope = {
            projectId: route.projectId,
            ...(route.workspaceId === undefined ? {} : { workspaceId: route.workspaceId }),
        };
        const project = store.getProject(route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (
            route.workspaceId !== undefined &&
            store.getWorkspace(route.projectId, route.workspaceId) === undefined
        ) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
        }
        if (route.name === "project-terminals") {
            if (request.method === "GET") {
                sendJson<ListRemoteTerminalsResponse>(response, 200, {
                    terminals: store.remoteTerminals
                        .list(scope)
                        .map((terminal) => terminal.summary()),
                });
                return;
            }
            if (request.method === "POST") {
                const body = await readJson<CreateRemoteTerminalRequest | null>(request);
                if (body === null || typeof body !== "object" || Array.isArray(body)) {
                    sendJson(response, 400, {
                        error: "Terminal settings must be a JSON object.",
                    });
                    return;
                }
                try {
                    const terminal = await store.remoteTerminals.create(scope, body);
                    sendJson<CreateRemoteTerminalResponse>(response, 201, {
                        terminal: terminal.summary(),
                    });
                } catch (error) {
                    sendJson(response, 400, { error: errorToMessage(error) });
                }
                return;
            }
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const terminal = store.remoteTerminals.get(scope, route.terminalId);
        if (terminal === undefined) {
            sendJson(response, 404, { error: "Terminal not found" });
            return;
        }
        if (request.method === "DELETE") {
            sendJson<RemoteTerminalResponse>(response, 200, { terminal: await terminal.stop() });
            return;
        }
        if (request.method === "PATCH") {
            const body = await readJson<ResizeRemoteTerminalRequest>(request);
            try {
                sendJson<RemoteTerminalResponse>(response, 200, {
                    terminal: await terminal.resize(body.cols, body.rows),
                });
            } catch (error) {
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (request.method === "GET" && route.name === "project-asset") {
        const asset = await store.getProjectAvatar(route.assetHash);
        if (asset === undefined) {
            sendJson(response, 404, { error: "Project avatar not found" });
            return;
        }
        response.writeHead(200, {
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": String(asset.bytes.byteLength),
            "content-type": asset.mediaType,
            etag: `"${asset.hash}"`,
        });
        response.end(asset.bytes);
        return;
    }

    if (route.name === "project") {
        const project = store.getProject(route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (request.method === "GET") {
            sendJson<ProjectResponse>(response, 200, { project });
            return;
        }
        if (request.method === "PATCH") {
            const body = await readJson<unknown>(request);
            if (
                (!hasOnlyObjectKeys(body, ["name"]) &&
                    !hasOnlyObjectKeys(body, ["mutationId", "name"])) ||
                typeof body.name !== "string" ||
                (body.mutationId !== undefined && typeof body.mutationId !== "string")
            ) {
                sendJson(response, 400, { error: "Project name must be text." });
                return;
            }
            const completed =
                body.mutationId === undefined
                    ? undefined
                    : store.globalEventQueue
                          .list()
                          ?.find(
                              (entry) =>
                                  entry.event.type === "project_updated" &&
                                  entry.event.projectId === project.id &&
                                  entry.event.data.mutationId === body.mutationId,
                          );
            if (completed !== undefined) {
                sendJson<ProjectResponse>(response, 200, {
                    project: store.getProject(project.id)!,
                });
                return;
            }
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendJson(response, 400, { error: "The project version is invalid." });
                return;
            }
            try {
                sendJson<ProjectResponse>(response, 200, {
                    project: store.renameProject(
                        project.id,
                        body.name,
                        expectedVersion,
                        body.mutationId,
                    )!,
                });
            } catch (error) {
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    project: store.getProject(project.id),
                });
            }
            return;
        }
    }

    if (route.name === "git-watch" && request.method === "POST") {
        const tracker = runtimeConfig.gitStateTracker;
        if (tracker === undefined) {
            sendJson(response, 503, { error: "Git tracking is unavailable." });
            return;
        }
        const body = await readJson<unknown>(request);
        if (!hasOnlyObjectKeys(body, ["entities"]) || !Array.isArray(body.entities)) {
            sendJson(response, 400, { error: "The watch request is invalid." });
            return;
        }
        for (const requested of body.entities as { projectId?: unknown; workspaceId?: unknown }[]) {
            if (typeof requested?.projectId !== "string") continue;
            const project = store.getProject(requested.projectId);
            if (project === undefined) continue;
            const workspace =
                typeof requested.workspaceId === "string"
                    ? store.getWorkspace(requested.projectId, requested.workspaceId)
                    : undefined;
            if (typeof requested.workspaceId === "string" && workspace === undefined) continue;
            const entity = resolveGitTrackedEntity(project, workspace);
            if (entity !== undefined) tracker.watch(entity);
        }
        sendJson<GitWatchResponse>(response, 200, { snapshots: tracker.liveSnapshots() });
        return;
    }

    if (route.name === "project-git" || route.name === "project-workspace-git") {
        const tracker = runtimeConfig.gitStateTracker;
        if (tracker === undefined) {
            sendJson(response, 503, { error: "Git tracking is unavailable." });
            return;
        }
        const project = store.getProject(route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        const workspace =
            route.name === "project-workspace-git"
                ? store.getWorkspace(route.projectId, route.workspaceId)
                : undefined;
        if (route.name === "project-workspace-git" && workspace === undefined) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
        }
        const entity = resolveGitTrackedEntity(project, workspace);
        if (entity === undefined) {
            sendJson(response, 409, {
                error: "This folder is not available for Git tracking right now.",
            });
            return;
        }
        if (request.method === "GET") {
            // Asking for a snapshot is itself the demand signal, so the entity stays warm.
            tracker.watch(entity);
            const cached = tracker.snapshot(entity);
            if (cached !== undefined && url.searchParams.get("refresh") !== "1") {
                sendJson<GitStateResponse>(response, 200, { git: cached });
                return;
            }
            const fresh = await tracker.refresh(entity);
            if (fresh === undefined) {
                sendJson(response, 503, { error: "Git tracking is unavailable." });
                return;
            }
            sendJson<GitStateResponse>(response, 200, { git: fresh });
            return;
        }
    }

    if (route.name === "project-refresh" && request.method === "POST") {
        try {
            const project = store.refreshProject(route.projectId);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 202, { project });
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-reorder" && request.method === "POST") {
        const body = await readJson<unknown>(request);
        if (!isReorderRequest(body)) {
            sendJson(response, 400, {
                error: "The preceding project ID must be text or null.",
            });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The project version is invalid." });
            return;
        }
        try {
            const project = store.reorderProject(route.projectId, body, expectedVersion);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 200, { project });
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-archive" && request.method === "POST") {
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The project version is invalid." });
            return;
        }
        try {
            const project = await store.archiveProject(route.projectId, expectedVersion);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 202, { project });
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-avatar") {
        if (request.method === "PUT") {
            const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
            if (
                contentType === undefined ||
                !["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff"].includes(
                    contentType,
                )
            ) {
                sendJson(response, 415, { error: "This project avatar format is not supported." });
                return;
            }
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendJson(response, 400, {
                    error: "The project avatar update requires a valid project version.",
                });
                return;
            }
            try {
                const bytes = await readBuffer(request, 8 * 1024 * 1024);
                const project = await store.setProjectAvatar(
                    route.projectId,
                    bytes,
                    expectedVersion,
                );
                if (project === undefined) {
                    sendJson(response, 404, { error: "Project not found" });
                    return;
                }
                sendJson<ProjectResponse>(response, 200, { project });
            } catch (error) {
                const message = errorToMessage(error);
                sendJson(
                    response,
                    error instanceof RequestBodyTooLargeError
                        ? 413
                        : message.includes("changed before")
                          ? 409
                          : 400,
                    { error: message },
                );
            }
            return;
        }
        if (request.method === "DELETE") {
            const project = store.clearProjectAvatar(route.projectId);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 200, { project });
            return;
        }
    }

    if (route.name === "project-workspaces") {
        if (store.getProject(route.projectId) === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (request.method === "GET") {
            sendJson<ListProjectWorkspacesResponse>(response, 200, {
                workspaces: store.listWorkspaces(route.projectId),
            });
            return;
        }
        if (request.method === "POST") {
            const body = await readJson<unknown>(request);
            if (
                !hasOnlyObjectKeys(body, ["baseRef", "clientRequestId", "name"]) ||
                typeof body.name !== "string" ||
                typeof body.baseRef !== "string" ||
                typeof body.clientRequestId !== "string"
            ) {
                sendJson(response, 400, { error: "Workspace settings are invalid." });
                return;
            }
            try {
                const workspace = await store.createWorkspace(route.projectId, {
                    baseRef: body.baseRef,
                    clientRequestId: body.clientRequestId,
                    name: body.name,
                });
                if (workspace === undefined) {
                    sendJson(response, 404, { error: "Project not found" });
                    return;
                }
                sendJson<ProjectWorkspaceResponse>(response, 202, { workspace });
            } catch (error) {
                const message = errorToMessage(error);
                sendJson(response, message.includes("already used") ? 409 : 400, {
                    error: message,
                });
            }
            return;
        }
    }

    if (route.name === "project-workspace") {
        const workspace = store.getWorkspace(route.projectId, route.workspaceId);
        if (workspace === undefined) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
        }
        if (request.method === "PATCH") {
            const body = await readJson<unknown>(request);
            if (
                (!hasOnlyObjectKeys(body, ["name"]) &&
                    !hasOnlyObjectKeys(body, ["mutationId", "name"])) ||
                typeof body.name !== "string" ||
                (body.mutationId !== undefined && typeof body.mutationId !== "string")
            ) {
                sendJson(response, 400, { error: "Workspace name must be text." });
                return;
            }
            const completed =
                body.mutationId === undefined
                    ? undefined
                    : store.globalEventQueue
                          .list()
                          ?.find(
                              (entry) =>
                                  entry.event.type === "workspace_updated" &&
                                  entry.event.workspaceId === route.workspaceId &&
                                  entry.event.data.mutationId === body.mutationId,
                          );
            if (completed !== undefined) {
                sendJson<ProjectWorkspaceResponse>(response, 200, {
                    workspace: store.getWorkspace(route.projectId, route.workspaceId)!,
                });
                return;
            }
            try {
                const expectedVersion = parseEntityVersion(request.headers["if-match"]);
                if (expectedVersion === undefined) {
                    sendJson(response, 400, { error: "The workspace version is invalid." });
                    return;
                }
                const renamed = store.renameWorkspace(
                    route.projectId,
                    route.workspaceId,
                    body.name,
                    expectedVersion,
                    body.mutationId,
                );
                if (renamed === undefined) {
                    sendJson(response, 404, { error: "Workspace not found" });
                    return;
                }
                sendJson<ProjectWorkspaceResponse>(response, 200, {
                    workspace: renamed,
                });
            } catch (error) {
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    workspace: store.getWorkspace(route.projectId, route.workspaceId),
                });
            }
            return;
        }
    }

    if (route.name === "project-workspace-archive" && request.method === "POST") {
        try {
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendJson(response, 400, { error: "The workspace version is invalid." });
                return;
            }
            const workspace = await store.archiveWorkspace(
                route.projectId,
                route.workspaceId,
                expectedVersion,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found" });
                return;
            }
            sendJson<ProjectWorkspaceResponse>(response, 202, { workspace });
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-workspace-reorder" && request.method === "POST") {
        const body = await readJson<unknown>(request);
        if (!isReorderRequest(body)) {
            sendJson(response, 400, {
                error: "The preceding workspace ID must be text or null.",
            });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The workspace version is invalid." });
            return;
        }
        try {
            const workspace = store.reorderWorkspace(
                route.projectId,
                route.workspaceId,
                body,
                expectedVersion,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found" });
                return;
            }
            sendJson<ProjectWorkspaceResponse>(response, 200, { workspace });
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && route.name === "messages" && route.sessionId === undefined) {
        const body = await readJson<unknown>(request);
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message settings are invalid." });
            return;
        }
        const broadcast = body as BroadcastMessageRequest;
        const allTargets = broadcast.all === true ? store.list({ limit: 501 }) : undefined;
        if (allTargets !== undefined && allTargets.length > 500) {
            sendJson(response, 409, {
                error: "A single broadcast can target at most 500 sessions.",
            });
            return;
        }
        const targets = allTargets?.map((summary) => summary.id) ?? broadcast.sessionIds;
        if (
            (broadcast.all === true) === (broadcast.sessionIds !== undefined) ||
            targets === undefined ||
            !Array.isArray(targets) ||
            targets.length === 0 ||
            targets.some((id) => typeof id !== "string")
        ) {
            sendJson(response, 400, {
                error: "Choose either all sessions or a non-empty list of session IDs.",
            });
            return;
        }
        if (targets.length > 500) {
            sendJson(response, 409, {
                error: "A single broadcast can target at most 500 sessions.",
            });
            return;
        }
        if (new Set(targets).size !== targets.length) {
            sendJson(response, 400, { error: "Session IDs must be unique." });
            return;
        }
        const sessions = targets.map((id) => store.get(id));
        if (sessions.some((candidate) => candidate === undefined)) {
            sendJson(response, 404, { error: "One or more sessions were not found." });
            return;
        }
        if (sessions.some((candidate) => candidate!.isSubagent())) {
            sendJson(response, 409, { error: "Subagent sessions cannot receive broadcasts." });
            return;
        }
        // Each session has its own model and provider, so one configuration cannot be meaningfully
        // applied to all of them at once.
        if (
            broadcast.effort !== undefined ||
            broadcast.modelId !== undefined ||
            broadcast.providerId !== undefined ||
            broadcast.serviceTier !== undefined
        ) {
            sendJson(response, 400, {
                error: "A broadcast cannot change the model, reasoning effort, or fast mode. Send those to one session at a time.",
            });
            return;
        }
        const { all: _all, sessionIds: _sessionIds, ...message } = broadcast;
        sendJson<BroadcastMessageResponse>(response, 202, {
            submissions: sessions.map((candidate) => candidate!.submit(message)),
        });
        return;
    }

    if (request.method === "GET" && route.name === "config") {
        sendJson<GetDaemonConfigResponse>(response, 200, {
            config: {
                settings: {
                    codexStreamMaxRetries: runtimeConfig.codexStreamMaxRetries,
                    durableGlobalEventQueue: runtimeConfig.globalEventQueue.durable,
                },
            },
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "config") {
        const body = await readJson<UpdateDaemonConfigRequest>(request);
        const codexStreamMaxRetries = body.settings?.codexStreamMaxRetries;
        const enabled = body.settings?.durableGlobalEventQueue;
        if (
            typeof codexStreamMaxRetries !== "number" ||
            !Number.isInteger(codexStreamMaxRetries) ||
            codexStreamMaxRetries < 0 ||
            codexStreamMaxRetries > MAX_CODEX_STREAM_MAX_RETRIES
        ) {
            sendJson(response, 400, {
                error: `Codex reconnect attempts must be a whole number from 0 to ${MAX_CODEX_STREAM_MAX_RETRIES}.`,
            });
            return;
        }
        if (typeof enabled !== "boolean") {
            sendJson(response, 400, {
                error: "Durable global event queue must be enabled or disabled.",
            });
            return;
        }
        if (runtimeConfig.onDaemonSettingsChange === undefined) {
            sendJson(response, 409, {
                error: "This daemon cannot change its settings at runtime.",
            });
            return;
        }
        const applied = await runtimeConfig.onDaemonSettingsChange({
            codexStreamMaxRetries,
            durableGlobalEventQueue: enabled,
        });
        if (
            applied === undefined ||
            applied.codexStreamMaxRetries !== codexStreamMaxRetries ||
            applied.globalEventQueue.durable !== enabled
        ) {
            throw new Error("The daemon could not apply the requested settings.");
        }
        runtimeConfig.codexStreamMaxRetries = applied.codexStreamMaxRetries;
        runtimeConfig.globalEventQueue = applied.globalEventQueue;
        sendJson<UpdateDaemonConfigResponse>(response, 200, {
            config: {
                settings: {
                    codexStreamMaxRetries,
                    durableGlobalEventQueue: enabled,
                },
            },
        });
        return;
    }

    if (request.method === "GET" && route.name === "catalog") {
        // The position is read before the entities, and both happen in one
        // synchronous pass, so the catalog states exactly the point in the stream
        // that it reflects. A client can then say of any event whether this
        // snapshot already contains it, instead of inferring it from what changed.
        sendJson<GlobalStreamHello>(response, 200, {
            cursor: store.liveEvents.cursor(),
            ...buildGroupCatalog(store, modelCatalog, identity, sessionTerminals),
        });
        return;
    }

    // Outside the durable-log gate on purpose: the live stream is the one
    // subscription a local client always has, whether or not events are stored.
    if (request.method === "GET" && route.name === "live-events-stream") {
        streamLiveEvents(request, response, store.liveEvents, url.searchParams.get("after"));
        return;
    }

    if (isGlobalEventRoute(route.name)) {
        const globalEventQueue = runtimeConfig.globalEventQueue;

        if (request.method === "GET" && route.name === "global-events") {
            const after = parseGlobalEventCursor(url.searchParams.get("after"));
            if (url.searchParams.has("after") && after === undefined) {
                sendJson(response, 400, { error: "The event cursor must be a UUIDv7 value." });
                return;
            }
            const limit = parseGlobalEventLimit(url.searchParams.get("limit"));
            if (url.searchParams.has("limit") && limit === undefined) {
                sendJson(response, 400, { error: "The event limit must be a positive number." });
                return;
            }
            const events = globalEventQueue.list({
                ...(after === undefined ? {} : { after }),
                limit: limit ?? 100,
            });
            if (events === undefined) {
                sendJson(response, 409, { error: "The global event cursor is not available." });
                return;
            }
            sendJson<ListGlobalEventsResponse>(response, 200, { events });
            return;
        }

        if (request.method === "GET" && route.name === "global-events-stream") {
            streamGlobalEvents(
                request,
                response,
                globalEventQueue,
                url.searchParams.get("after"),
                () => {
                    const projects = store
                        .listProjects()
                        .filter((project) => project.archivedAt === undefined);
                    const projectIds = new Set(projects.map((project) => project.id));
                    const workspaces = store
                        .listWorkspaces()
                        .filter(
                            (workspace) =>
                                projectIds.has(workspace.projectId) &&
                                workspace.archivedAt === undefined &&
                                workspace.status !== "archived",
                        );
                    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
                    const sessions = store.listActive().filter((session) => !session.archived);
                    return [
                        ...(runtimeConfig.gitStateTracker?.liveSnapshots() ?? []).filter(
                            (event) =>
                                projectIds.has(event.projectId) &&
                                (!("workspaceId" in event) ||
                                    event.workspaceId === undefined ||
                                    workspaceIds.has(event.workspaceId)),
                        ),
                        ...store.remoteTerminals.groups().flatMap((group) =>
                            !projectIds.has(group.scope.projectId) ||
                            (group.scope.workspaceId !== undefined &&
                                !workspaceIds.has(group.scope.workspaceId))
                                ? []
                                : [
                                      {
                                          createdAt: Date.now(),
                                          data: { terminals: group.terminals },
                                          id: createTerminalSnapshotEventId(),
                                          projectId: group.scope.projectId,
                                          type: "remote_terminals_changed" as const,
                                          ...(group.scope.workspaceId === undefined
                                              ? {}
                                              : { workspaceId: group.scope.workspaceId }),
                                      },
                                  ],
                        ),
                        ...sessions.map((session) => ({
                            createdAt: Date.now(),
                            data: { session },
                            // The stream frame has its own fresh cursor; the
                            // authoritative session version remains in
                            // session.lastEventId for mutation preconditions.
                            id: createSessionSnapshotEventId(),
                            sessionId: session.id,
                            type: "session_current" as const,
                        })),
                    ];
                },
                () => buildGroupCatalog(store, modelCatalog, identity, sessionTerminals),
            );
            return;
        }

        if (request.method === "POST" && route.name === "global-events-trim") {
            const body = await readJson<TrimGlobalEventsRequest>(request);
            if (parseGlobalEventCursor(body.through) === undefined) {
                sendJson(response, 400, { error: "The trim cursor is invalid." });
                return;
            }
            const result = globalEventQueue.trim(body.through);
            if (result === undefined) {
                sendJson(response, 409, { error: "The global event cursor is not available." });
                return;
            }
            sendJson<TrimGlobalEventsResponse>(response, 200, result);
            return;
        }

        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (
        request.method === "GET" &&
        route.name === "external-tool-calls" &&
        route.sessionId === undefined
    ) {
        const status = url.searchParams.get("status") ?? "pending";
        if (!["pending", "completed", "failed", "cancelled"].includes(status)) {
            sendJson(response, 400, { error: "External function status is invalid." });
            return;
        }
        const limit = parseLimit(url.searchParams.get("limit"));
        if (url.searchParams.has("limit") && limit === undefined) {
            sendJson(response, 400, { error: "External function call limit is invalid." });
            return;
        }
        sendJson<ListExternalToolCallsResponse>(response, 200, {
            calls: store.listExternalToolCalls({
                limit: limit ?? 100,
                status: status as import("../external-tools/index.js").ExternalToolCall["status"],
            }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "secret-registrations") {
        sendJson<ListSecretsResponse>(response, 200, { secrets: store.listSecrets() });
        return;
    }

    if (request.method === "POST" && route.name === "secret-registrations") {
        const body = await readJson<unknown>(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Secret settings must be a JSON object." });
            return;
        }
        try {
            sendJson<RegisterSecretResponse>(response, 200, {
                secret: store.registerSecret(body as RegisterSecretRequest),
            });
        } catch (error) {
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : "The secret could not be saved.",
            });
        }
        return;
    }

    if (request.method === "DELETE" && route.name === "secret-registration") {
        sendJson<UnregisterSecretResponse>(response, 200, {
            removed: store.unregisterSecret(route.secretId),
        });
        return;
    }

    if (request.method === "POST" && route.name === "sessions") {
        const body = await readJson<CreateSessionRequest | null>(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Session settings must be a JSON object." });
            return;
        }
        if (body.permissionMode !== undefined && !isPermissionMode(body.permissionMode)) {
            sendJson(response, 400, {
                error: INVALID_PERMISSION_MODE_MESSAGE,
            });
            return;
        }
        if (body.appendSystemPrompt !== undefined && typeof body.appendSystemPrompt !== "string") {
            sendJson(response, 400, {
                error: "The appended system prompt must be text.",
            });
            return;
        }
        if (body.trackUnread !== undefined && typeof body.trackUnread !== "boolean") {
            sendJson(response, 400, {
                error: "Unread tracking must be true or false.",
            });
            return;
        }
        if (
            body.secretIds !== undefined &&
            (!Array.isArray(body.secretIds) ||
                body.secretIds.some((secretId) => typeof secretId !== "string"))
        ) {
            sendJson(response, 400, {
                error: "Secret IDs must be provided as a list of text IDs.",
            });
            return;
        }
        if (
            body.clientSessionId !== undefined &&
            (typeof body.clientSessionId !== "string" ||
                body.clientSessionId.length === 0 ||
                body.clientSessionId.length > 256)
        ) {
            sendJson(response, 400, { error: "The client session ID is invalid." });
            return;
        }
        try {
            const sessionRequest = configureSessionRequest(body, defaultDocker);
            const session =
                body.clientSessionId === undefined
                    ? store.create(sessionRequest)
                    : store.createWithId(body.clientSessionId, sessionRequest);
            sendJson<CreateSessionResponse>(response, 201, { session: session.snapshot() });
        } catch (error) {
            sendJson(response, error instanceof SessionConfigurationError ? 400 : 409, {
                error: error instanceof Error ? error.message : "The session could not be created.",
            });
        }
        return;
    }

    if (request.method === "GET" && route.name === "sessions") {
        const limit = parseLimit(url.searchParams.get("limit"));
        const archived = parseArchivedFilter(url.searchParams.get("archived"));
        if (url.searchParams.has("archived") && archived === undefined) {
            sendJson(response, 400, {
                error: "Archived sessions must be filtered with true, false, or all.",
            });
            return;
        }
        const summaries = store.list();
        const filtered =
            archived === "all"
                ? summaries
                : summaries.filter((summary) => summary.archived === (archived ?? false));
        const sessions = filtered.map((summary) =>
            sessionSummaryWithTerminalPresence(summary, sessionTerminals),
        );
        sendJson<ListSessionsResponse>(response, 200, {
            sessions: limit === undefined ? sessions : sessions.slice(0, limit),
        });
        return;
    }

    const sessionId = route.sessionId;
    if (sessionId === undefined) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    const session = store.get(sessionId);
    if (session === undefined) {
        sendJson(response, 404, { error: "Session not found" });
        return;
    }

    if (route.name === "terminal-connection") {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and cannot accept terminal connections.",
            });
            return;
        }
        if (request.method === "PUT") {
            const body = await readJson<SessionTerminalHeartbeatRequest | null>(request);
            if (
                body === null ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                body.connectionId !== route.connectionId
            ) {
                sendJson(response, 400, { error: "Terminal heartbeat settings are invalid." });
                return;
            }
            try {
                const hadFocusedTerminal = sessionTerminals.hasFocusedTerminal(sessionId);
                sessionTerminals.heartbeat(sessionId, body);
                if (hadFocusedTerminal || sessionTerminals.hasFocusedTerminal(sessionId)) {
                    session.markRead();
                }
                sendJson<SessionTerminalHeartbeatResponse>(response, 200, { connected: true });
            } catch (error) {
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        if (request.method === "DELETE") {
            if (sessionTerminals.hasFocusedTerminal(sessionId)) session.markRead();
            sendJson<DisconnectSessionTerminalResponse>(response, 200, {
                disconnected: sessionTerminals.disconnect(sessionId, route.connectionId),
            });
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (request.method === "GET" && route.name === "session") {
        const messageLimit = parseLimit(url.searchParams.get("message_limit"));
        if (url.searchParams.has("message_limit") && messageLimit === undefined) {
            sendJson(response, 400, { error: "Session message limit is invalid." });
            return;
        }
        sendJson(response, 200, {
            session: limitProtocolSessionMessages(session.snapshot(), messageLimit),
        });
        return;
    }

    if (request.method === "POST" && route.name === "reorder") {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and cannot be reordered.",
            });
            return;
        }
        const body = await readJson<unknown>(request);
        if (!isReorderRequest(body)) {
            sendJson(response, 400, {
                error: "The preceding chat ID must be text or null.",
            });
            return;
        }
        try {
            sendJson(response, 200, {
                session: store.reorderSession(sessionId, body)!.snapshot(),
            });
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && (route.name === "archive" || route.name === "unarchive")) {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and cannot be archived.",
            });
            return;
        }
        if (route.name === "unarchive" && session.snapshot().status === "archived") {
            sendJson(response, 409, {
                error: "A session archived with its workspace cannot be restored.",
            });
            return;
        }
        /*
         * Archive state controls listing visibility only. It never stops or deletes a session:
         * running and queued sessions may be hidden, and every archived session remains readable
         * and resumable by ID. Repeating either action is intentionally idempotent.
         */
        const mutationId = requestMutationId(request);
        const completed =
            mutationId === undefined
                ? undefined
                : session.events
                      .since(undefined)
                      ?.find(
                          (event) =>
                              event.type === "session_archived" &&
                              event.data.mutationId === mutationId,
                      );
        if (completed !== undefined) {
            sendJson<SessionArchiveResponse>(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const archived = session.setArchived(route.name === "archive", mutationId);
        if (route.name === "unarchive") {
            // A visible chat must never sit under a project the user archived.
            store.unarchiveProject(archived.projectId);
        }
        sendJson<SessionArchiveResponse>(response, 200, { session: archived });
        return;
    }

    if (request.method === "PATCH" && route.name === "session") {
        const body = await readJson<UpdateSessionRequest | null>(request);
        if (
            body === null ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            (typeof body.appendSystemPrompt !== "string" && body.appendSystemPrompt !== null)
        ) {
            sendJson(response, 400, {
                error: "The appended system prompt must be text or null.",
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: session.update({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "current-provider-quota") {
        const currentProviderId = session.snapshot().providerId;
        const quota = await session.providerQuota();
        sendJson<GetCurrentProviderQuotaResponse>(response, 200, {
            currentProviderId,
            ...(quota === undefined ? {} : { quota }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "session-state") {
        // The position is read before the session is described, so the payload
        // states the point in the live stream it reflects. Everything after that
        // position arrives on the global stream and is replayed on top of this.
        const cursor = store.liveEvents.cursor();
        const turnLimit = parseTurnLimit(url.searchParams.get("turns"));
        const hello = sessionStateHello(session, turnLimit, store.listSubagents(sessionId));
        // A client catching up says which message it already holds, and receives
        // only the turns from there on. It still gets the whole current session,
        // because a gap leaves the rest of that state uncertain too — but the
        // conversation itself, which is the part that can be colossal, is sent
        // incrementally rather than from the beginning.
        const after = url.searchParams.get("after") ?? undefined;
        const forward = after === undefined ? undefined : session.transcriptSince(after, turnLimit);
        if (after !== undefined && forward !== undefined) {
            sendJson<SessionStateResponse>(response, 200, {
                ...hello,
                append: true,
                cursor,
                transcript: forward,
            });
            return;
        }
        // No anchor, or one too old to page from: the newest turns instead, which
        // the client takes as a replacement rather than an addition.
        sendJson<SessionStateResponse>(response, 200, { cursor, ...hello });
        return;
    }

    if (request.method === "GET" && route.name === "transcript") {
        // Paging forward is how a client that missed events catches up; paging
        // backward is how it reads further into the past.
        const after = url.searchParams.get("after") ?? undefined;
        if (after !== undefined) {
            const forward = session.transcriptSince(after, SESSION_STREAM_TURN_LIMIT);
            if (forward === undefined) {
                sendJson(response, 409, {
                    error: "That part of the conversation is no longer available.",
                });
                return;
            }
            sendJson(response, 200, forward);
            return;
        }
        const before = url.searchParams.get("before") ?? undefined;
        const page = session.transcriptPage(SESSION_STREAM_TURN_LIMIT, before);
        if (page === undefined) {
            // The anchor turn is gone, so the reader's view of the conversation
            // is stale and paging from it would duplicate or misplace content.
            sendJson(response, 409, {
                error: "That part of the conversation is no longer available.",
            });
            return;
        }
        sendJson(response, 200, page);
        return;
    }

    if (request.method === "GET" && route.name === "usage") {
        const sessionEvents = session.events.all();
        const usage = session.usage(sessionEvents);
        const currentProviderId = session.snapshot().providerId;
        const providerIds = [
            ...new Set([
                ...usage.groups.flatMap((group) =>
                    group.providerId === null ? [] : [group.providerId],
                ),
                ...usage.observedQuota.map((contribution) => contribution.providerId),
                currentProviderId,
            ]),
        ];
        const observedQuotas = session.events.latestProviderQuotas();
        const quotas = (
            await Promise.all(
                providerIds.map(async (providerId) => {
                    const loadedQuota =
                        providerId === currentProviderId
                            ? await session.providerQuota()
                            : await getProviderQuota?.(providerId);
                    const observedQuota = observedQuotas.get(providerId);
                    const quota =
                        observedQuota !== undefined &&
                        (loadedQuota === undefined ||
                            observedQuota.capturedAt >= loadedQuota.capturedAt)
                            ? observedQuota
                            : loadedQuota;
                    return quota === undefined ? undefined : { providerId, quota };
                }),
            )
        ).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        sendJson<GetSessionUsageResponse>(response, 200, {
            currentProviderId,
            groups: usage.groups,
            observedQuota: usage.observedQuota,
            quotas,
            sessionTokenCount: usage.sessionTokenCount,
            ...(usage.currentContext === undefined ? {} : { context: usage.currentContext }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "subagents") {
        sendJson<ListSubagentsResponse>(response, 200, {
            subagents: store.listSubagents(sessionId),
        });
        return;
    }

    if (request.method === "POST" && route.name === "workflow-stop") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            const workflow = session
                .listWorkflows()
                .find((candidate) => candidate.runId === route.workflowRunId);
            sendJson(
                response,
                workflow === undefined ? 404 : 200,
                workflow === undefined ? { error: "Workflow not found" } : { workflow },
            );
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const workflow = session.stopWorkflow(route.workflowRunId);
        if (workflow === undefined) {
            sendJson(response, 404, { error: "Workflow not found" });
            return;
        }
        session.recordMutationApplied(mutationId);
        sendJson<StopWorkflowResponse>(response, 200, { workflow });
        return;
    }

    if (route.name === "file" && (request.method === "GET" || request.method === "PUT")) {
        try {
            if (request.method === "GET") {
                const path = url.searchParams.get("path");
                if (path === null || path.length === 0) {
                    sendJson(response, 400, { error: "A file path is required." });
                    return;
                }
                sendJson<ReadSessionFileResponse>(
                    response,
                    200,
                    await readSessionFile(session.externalControlContext(), path),
                );
                return;
            }

            if (session.isSubagent()) {
                sendJson(response, 409, {
                    error: "Subagent histories are read-only and cannot update files.",
                });
                return;
            }
            const body = await readJson<unknown>(request, 44 * 1024 * 1024);
            if (
                !hasOnlyObjectKeys(body, ["content", "expectedHash", "path"]) ||
                typeof body.content !== "string" ||
                (typeof body.expectedHash !== "string" && body.expectedHash !== null) ||
                typeof body.path !== "string" ||
                body.path.length === 0
            ) {
                sendJson(response, 400, { error: "File update settings are invalid." });
                return;
            }
            sendJson<WriteSessionFileResponse>(
                response,
                200,
                await writeSessionFile(
                    session.externalControlContext(),
                    body as unknown as WriteSessionFileRequest,
                ),
            );
        } catch (error) {
            const status =
                error instanceof SessionFileConflictError
                    ? 409
                    : error instanceof SessionFileTooLargeError
                      ? 413
                      : error instanceof Error &&
                          (error.message.includes("disabled in read-only mode") ||
                              error.message.includes("cannot modify files outside") ||
                              error.message.includes("cannot modify Git control files"))
                        ? 403
                        : 400;
            sendJson(response, status, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "GET" && route.name === "files") {
        const query = (url.searchParams.get("query") ?? "").slice(0, 512);
        const files = await fileSearchService.search(
            session.snapshot().cwd,
            query,
            parseFileSearchLimit(url.searchParams.get("limit")),
        );
        sendJson<SearchFilesResponse>(response, 200, { files });
        return;
    }

    if (request.method === "POST" && route.name === "fork") {
        if (session.isSubagent()) {
            sendJson(response, 409, { error: "Subagent histories cannot be forked." });
            return;
        }
        const targetSessionId = requestMutationId(request);
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const forked = store.fork(sessionId, targetSessionId);
            if (forked === undefined) {
                sendJson(response, 404, { error: "Session not found" });
                return;
            }
            sendJson<ForkSessionResponse>(response, 201, { session: forked.snapshot() });
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The session could not be forked.",
            });
        }
        return;
    }

    if (session.isSubagent() && isSessionMutation(route.name, request.method)) {
        sendJson(response, 409, {
            error: "Subagent histories are read-only and cannot be resumed.",
        });
        return;
    }

    if (request.method === "POST" && route.name === "messages") {
        const body = await readJson<unknown>(request);
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message text must be text." });
            return;
        }
        if (body.clientSubmissionId !== undefined) {
            const submitted = session.events.messageSubmission(body.clientSubmissionId);
            if (submitted !== undefined) {
                sendJson<SubmitMessageResponse>(response, 202, {
                    eventId: submitted.id,
                    runId: submitted.data.runId,
                    sessionId: session.id,
                });
                return;
            }
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        // A user working in an explicitly archived session makes it visible again.
        const mutationId = body.mutationId ?? requestMutationId(request);
        sendJson<SubmitMessageResponse>(
            response,
            202,
            session.submit({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        );
        return;
    }

    if (request.method === "GET" && route.name === "external-tool-calls") {
        sendJson(response, 200, { calls: session.externalToolCalls() });
        return;
    }

    if (request.method === "POST" && route.name === "external-tool-call") {
        const body = await readJson<unknown>(request, 1_048_576);
        if (!isExternalToolCallResolution(body)) {
            sendJson(response, 400, { error: "External function result is invalid." });
            return;
        }
        try {
            const result = session.resolveExternalToolCall(
                route.externalToolCallId,
                body as ResolveExternalToolCallRequest,
            );
            if (result === undefined) {
                sendJson(response, 404, { error: "External function call not found." });
                return;
            }
            sendJson<ResolveExternalToolCallResponse>(response, 200, result);
        } catch (error) {
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && route.name === "activity") {
        session.recordUserActivity();
        sendJson<RecordSessionActivityResponse>(response, 200, { recorded: true });
        return;
    }

    if (request.method === "POST" && route.name === "steer") {
        const body = await readJson<unknown>(request);
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message text must be text." });
            return;
        }
        try {
            sendJson<SteerMessageResponse>(response, 202, session.steer(body));
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The active run cannot be steered.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "abort") {
        const mutationId = requestMutationId(request);
        const completed =
            mutationId === undefined
                ? undefined
                : session.events
                      .since(undefined)
                      ?.find(
                          (event) =>
                              event.type === "abort_requested" &&
                              event.data.mutationId === mutationId,
                      );
        if (completed !== undefined) {
            sendJson<AbortRunResponse>(response, 200, {
                aborted: true,
                eventId: completed.id,
            });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const expectedRunId = url.searchParams.get("expectedRunId") ?? undefined;
            const steeringMessageIds = url.searchParams.getAll("steeringMessageId");
            sendJson<AbortRunResponse>(
                response,
                200,
                await session.abort({
                    continuePendingSteering:
                        url.searchParams.get("continuePendingSteering") === "1",
                    ...(expectedRunId === undefined ? {} : { expectedRunId }),
                    ...(mutationId === undefined ? {} : { mutationId }),
                    ...(steeringMessageIds.length === 0 ? {} : { steeringMessageIds }),
                }),
            );
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The run could not be aborted.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "background-processes-stop") {
        const stoppedProcesses = await session.stopBackgroundProcesses();
        sendJson(response, 200, { stoppedProcesses });
        return;
    }

    if (route.name === "background-process") {
        if (request.method === "GET") {
            const rawWaitMs = url.searchParams.get("waitMs");
            const waitMs =
                rawWaitMs === null
                    ? 0
                    : Math.max(0, Math.min(30_000, Number.parseInt(rawWaitMs, 10) || 0));
            const process = await session.readBackgroundProcess(route.processSessionId, {
                waitMs,
            });
            if (process === undefined) {
                sendJson(response, 404, { error: "The background terminal was not found." });
                return;
            }
            sendJson<ReadBackgroundProcessResponse>(response, 200, process);
            return;
        }
        if (request.method === "DELETE") {
            const result = await session.stopBackgroundProcess(route.processSessionId);
            sendJson<StopBackgroundProcessResponse>(response, 200, result);
            return;
        }
    }

    if (request.method === "POST" && route.name === "shell") {
        const body = await readJson<unknown>(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Enter a shell command after !." });
            return;
        }
        const candidate = body as Partial<RunShellCommandRequest>;
        if (
            typeof candidate.command !== "string" ||
            candidate.command.trim().length === 0 ||
            typeof candidate.commandId !== "string" ||
            candidate.commandId.length === 0
        ) {
            sendJson(response, 400, { error: "Enter a shell command after !." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, {});
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const result = await session.runShellCommand(candidate as RunShellCommandRequest);
        session.recordMutationApplied(mutationId);
        sendJson<RunShellCommandResponse>(response, 200, result);
        return;
    }

    if (request.method === "POST" && route.name === "reset") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        await session.reset();
        session.recordMutationApplied(mutationId);
        sendJson(response, 200, { session: session.snapshot() });
        return;
    }

    if (request.method === "POST" && route.name === "rewind") {
        const body = await readJson<RewindSessionRequest>(request);
        if (typeof body.messageId !== "string" || body.messageId.length === 0) {
            sendJson(response, 400, { error: "Choose a user message to rewind to." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const result = session.rewind(body.messageId);
            session.recordMutationApplied(mutationId);
            sendJson<RewindSessionResponse>(response, 200, {
                ...result,
                session: session.snapshot(),
            });
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The session could not be rewound.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "compact") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const result = await session.compact();
        session.recordMutationApplied(mutationId);
        sendJson<CompactSessionResponse>(response, 200, {
            result,
            session: session.snapshot(),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "effort") {
        const body = await readJson<ChangeEffortRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: session.changeEffort({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "service-tier") {
        const body = await readJson<ChangeServiceTierRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: session.changeServiceTier({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "model") {
        const body = await readJson<ChangeModelRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        const completed =
            mutationId === undefined
                ? undefined
                : session.events
                      .since(undefined)
                      ?.find(
                          (event) =>
                              event.type === "session_configuration_changed" &&
                              event.data.mutationId === mutationId,
                      );
        if (completed !== undefined) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            sendJson(response, 200, {
                session: session.changeModel({
                    ...body,
                    ...(mutationId === undefined ? {} : { mutationId }),
                }),
            });
        } catch (error) {
            sendJson(response, 409, {
                error: errorToMessage(error),
                session: session.snapshot(),
            });
        }
        return;
    }

    if (request.method === "PATCH" && route.name === "permissions") {
        const body = await readJson<ChangePermissionModeRequest>(request);
        if (!isPermissionMode(body.permissionMode)) {
            sendJson(response, 400, {
                error: INVALID_PERMISSION_MODE_MESSAGE,
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: await session.changePermissionMode({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "PUT" && route.name === "draft") {
        const body = await readJson<SetSessionDraftRequest | null>(request);
        if (
            body === null ||
            typeof body !== "object" ||
            (body.draft !== null && typeof body.draft !== "string") ||
            (body.updatedAt !== undefined && typeof body.updatedAt !== "number")
        ) {
            sendJson(response, 400, { error: "A draft must be text." });
            return;
        }
        if (typeof body.draft === "string" && body.draft.length > SESSION_DRAFT_MAX_LENGTH) {
            sendJson(response, 400, {
                error: "This draft is too long to sync. It stays on this terminal only.",
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: session.setDraft({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "POST" && route.name === "secrets") {
        const body = await readJson<AttachSecretRequest | null>(request);
        if (
            body === null ||
            typeof body !== "object" ||
            typeof body.secretId !== "string" ||
            body.secretId.length === 0
        ) {
            sendJson(response, 400, { error: "Choose a secret to attach." });
            return;
        }
        const scope = body.scope ?? "session";
        if (scope !== "session" && scope !== "project") {
            sendJson(response, 400, { error: "Secret scope must be Session or Project." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            sendJson<SecretSessionResponse>(response, 200, {
                session:
                    store.attachSecret(session.id, body.secretId, scope, mutationId)?.snapshot() ??
                    session.snapshot(),
            });
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The secret could not be attached.",
            });
        }
        return;
    }

    if (request.method === "DELETE" && route.name === "secret") {
        const scope = url.searchParams.get("scope") ?? "session";
        if (scope !== "session" && scope !== "project") {
            sendJson(response, 400, { error: "Secret scope must be Session or Project." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson<SecretSessionResponse>(response, 200, {
            session:
                store.detachSecret(session.id, route.secretId, scope, mutationId)?.snapshot() ??
                session.snapshot(),
        });
        return;
    }

    if (request.method === "POST" && route.name === "goal") {
        const body = await readJson<SetGoalRequest>(request);
        if (typeof body.objective !== "string") {
            sendJson(response, 400, { error: "Goal objective must be text." });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            session.setGoal(body, mutationId);
            sendJson<GoalSessionResponse>(response, 200, { session: session.snapshot() });
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The goal could not be started.",
            });
        }
        return;
    }

    if (request.method === "PATCH" && route.name === "goal") {
        const body = await readJson<ChangeSessionGoalStatusRequest>(request);
        if (!isGoalStatus(body.status)) {
            sendJson(response, 400, {
                error: "Goal status must be Active, Paused, Blocked, or Complete.",
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            session.changeGoalStatus(body, mutationId === undefined ? {} : { mutationId });
            sendJson<GoalSessionResponse>(response, 200, { session: session.snapshot() });
        } catch (error) {
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The goal could not be updated.",
            });
        }
        return;
    }

    if (request.method === "DELETE" && route.name === "goal") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        session.clearGoal(mutationId);
        sendJson<GoalSessionResponse>(response, 200, { session: session.snapshot() });
        return;
    }

    if (request.method === "POST" && route.name === "user-input") {
        const body = await readJson<AnswerUserInputRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const snapshot = session.answerUserInput(route.requestId, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            if (snapshot === undefined) {
                sendJson(response, 409, {
                    error: "This question is no longer waiting for an answer.",
                });
                return;
            }
            sendJson(response, 200, { session: snapshot });
        } catch (error) {
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : "The answer is invalid.",
            });
        }
        return;
    }

    if (request.method === "GET" && route.name === "events") {
        const after = url.searchParams.get("after") ?? undefined;
        if (after !== undefined && url.searchParams.has("message_limit")) {
            sendJson(response, 400, {
                error: "A session message limit is only supported while loading initial history.",
            });
            return;
        }
        const messageLimit = parseLimit(url.searchParams.get("message_limit"));
        if (url.searchParams.has("message_limit") && messageLimit === undefined) {
            sendJson(response, 400, { error: "Session message limit is invalid." });
            return;
        }
        const events = session.events.since(after);
        if (events === undefined) {
            sendJson(response, 409, { error: "Event cursor not found" });
            return;
        }
        sendJson(response, 200, {
            events: selectRecentSessionEvents(
                after === undefined
                    ? events.filter((event) => !isLiveOnlySessionEvent(event))
                    : events,
                after === undefined ? messageLimit : undefined,
            ),
        });
        return;
    }

    if (request.method === "GET" && route.name === "stream") {
        streamEvents(
            request,
            response,
            session,
            url.searchParams.get("after") ?? undefined,
            sessionEventStreamLeases,
            parseTurnLimit(url.searchParams.get("turns")),
            store.listSubagents(sessionId),
        );
        return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
}

function healthResponse(
    catalog: ModelCatalog,
    identity: DaemonIdentity,
    durableGlobalEventQueue: boolean,
): HealthResponse {
    return {
        catalog,
        durableGlobalEventQueue,
        healthy: true,
        identity,
        protocolVersion: RIG_PROTOCOL_VERSION,
        ready: true,
        status: "ready",
    };
}

function parseLimit(value: string | null): number | undefined {
    if (value === null) {
        return undefined;
    }

    const limit = Number.parseInt(value, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
        return undefined;
    }
    return Math.min(limit, 500);
}

function parseArchivedFilter(value: string | null): boolean | "all" | undefined {
    if (value === null || value === "false") return false;
    if (value === "true") return true;
    if (value === "all") return "all";
    return undefined;
}

function parseFileSearchLimit(value: string | null): number {
    if (value === null) {
        return 20;
    }

    const limit = Number.parseInt(value, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
        return 20;
    }
    return Math.min(limit, 50);
}

function matchRoute(pathname: string):
    | {
          name:
              | "global-events"
              | "git-watch"
              | "global-events-stream"
              | "live-events-stream"
              | "catalog"
              | "global-events-trim"
              | "external-tool-calls"
              | "config"
              | "debug-inspector"
              | "health"
              | "happy-reload"
              | "messages"
              | "models"
              | "projects"
              | "secret-registrations"
              | "sessions"
              | "state"
              | "shutdown";
          sessionId?: undefined;
      }
    | { assetHash: string; name: "project-asset"; sessionId?: undefined }
    | {
          name:
              | "project"
              | "project-archive"
              | "project-avatar"
              | "project-git"
              | "project-refresh"
              | "project-reorder"
              | "project-workspaces";
          projectId: string;
          sessionId?: undefined;
      }
    | {
          name:
              | "project-workspace"
              | "project-workspace-archive"
              | "project-workspace-git"
              | "project-workspace-reorder";
          projectId: string;
          sessionId?: undefined;
          workspaceId: string;
      }
    | {
          name: "project-terminals";
          projectId: string;
          sessionId?: undefined;
          workspaceId?: string;
      }
    | {
          name: "project-terminal";
          projectId: string;
          sessionId?: undefined;
          terminalId: string;
          workspaceId?: string;
      }
    | { name: "secret-registration"; secretId: string; sessionId?: undefined }
    | {
          name:
              | "abort"
              | "activity"
              | "archive"
              | "background-processes-stop"
              | "compact"
              | "current-provider-quota"
              | "draft"
              | "effort"
              | "events"
              | "external-tool-calls"
              | "file"
              | "files"
              | "fork"
              | "goal"
              | "messages"
              | "model"
              | "permissions"
              | "reorder"
              | "reset"
              | "rewind"
              | "shell"
              | "secrets"
              | "service-tier"
              | "session"
              | "stream"
              | "session-state"
              | "steer"
              | "transcript"
              | "subagents"
              | "unarchive"
              | "usage";
          sessionId: string;
      }
    | {
          connectionId: string;
          name: "terminal-connection";
          sessionId: string;
      }
    | { name: "user-input"; requestId: string; sessionId: string }
    | { name: "external-tool-call"; externalToolCallId: string; sessionId: string }
    | { name: "secret"; secretId: string; sessionId: string }
    | { name: "background-process"; processSessionId: number; sessionId: string }
    | { name: "workflow-stop"; sessionId: string; workflowRunId: string }
    | undefined {
    if (pathname === "/health") return { name: "health" };
    if (pathname === "/happy/reload") return { name: "happy-reload" };
    if (pathname === "/config") return { name: "config" };
    if (pathname === "/debug/inspector") return { name: "debug-inspector" };
    if (pathname === "/events") return { name: "global-events" };
    if (pathname === "/events/stream") return { name: "global-events-stream" };
    if (pathname === "/events/live") return { name: "live-events-stream" };
    if (pathname === "/catalog") return { name: "catalog" };
    if (pathname === "/events/trim") return { name: "global-events-trim" };
    if (pathname === "/external-tool-calls") return { name: "external-tool-calls" };
    if (pathname === "/models") return { name: "models" };
    if (pathname === "/messages") return { name: "messages" };
    if (pathname === "/git/watch") return { name: "git-watch" };
    if (pathname === "/projects") return { name: "projects" };
    if (pathname === "/secrets") return { name: "secret-registrations" };
    if (pathname === "/sessions") return { name: "sessions" };
    if (pathname === "/state") return { name: "state" };
    if (pathname === "/shutdown") return { name: "shutdown" };

    const globalParts = pathname.split("/").filter(Boolean);
    if (
        globalParts.length === 2 &&
        globalParts[0] === "project-assets" &&
        globalParts[1] !== undefined
    ) {
        return {
            assetHash: decodeURIComponent(globalParts[1]),
            name: "project-asset",
        };
    }
    if (globalParts[0] === "projects" && globalParts[1] !== undefined) {
        const projectId = decodeURIComponent(globalParts[1]);
        if (globalParts.length === 2) return { name: "project", projectId };
        if (globalParts.length === 3 && globalParts[2] === "archive") {
            return { name: "project-archive", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "avatar") {
            return { name: "project-avatar", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "refresh") {
            return { name: "project-refresh", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "reorder") {
            return { name: "project-reorder", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "terminals") {
            return { name: "project-terminals", projectId };
        }
        if (
            globalParts.length === 4 &&
            globalParts[2] === "terminals" &&
            globalParts[3] !== undefined
        ) {
            return {
                name: "project-terminal",
                projectId,
                terminalId: decodeURIComponent(globalParts[3]),
            };
        }
        if (globalParts.length === 3 && globalParts[2] === "git") {
            return { name: "project-git", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "workspaces") {
            return { name: "project-workspaces", projectId };
        }
        if (
            globalParts.length >= 4 &&
            globalParts[2] === "workspaces" &&
            globalParts[3] !== undefined
        ) {
            const workspaceId = decodeURIComponent(globalParts[3]);
            if (globalParts.length === 4) {
                return { name: "project-workspace", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "archive") {
                return { name: "project-workspace-archive", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "reorder") {
                return { name: "project-workspace-reorder", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "terminals") {
                return { name: "project-terminals", projectId, workspaceId };
            }
            if (
                globalParts.length === 6 &&
                globalParts[4] === "terminals" &&
                globalParts[5] !== undefined
            ) {
                return {
                    name: "project-terminal",
                    projectId,
                    terminalId: decodeURIComponent(globalParts[5]),
                    workspaceId,
                };
            }
            if (globalParts.length === 5 && globalParts[4] === "git") {
                return { name: "project-workspace-git", projectId, workspaceId };
            }
        }
    }
    if (globalParts.length === 2 && globalParts[0] === "secrets") {
        return {
            name: "secret-registration",
            secretId: decodeURIComponent(globalParts[1] ?? ""),
        };
    }

    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "sessions" || parts[1] === undefined) {
        return undefined;
    }

    const sessionId = decodeURIComponent(parts[1]);
    if (parts.length === 2) return { name: "session", sessionId };
    if (parts.length === 3 && parts[2] === "reorder") {
        return { name: "reorder", sessionId };
    }
    if (parts.length === 4 && parts[2] === "terminal-connections" && parts[3] !== undefined) {
        return {
            connectionId: decodeURIComponent(parts[3]),
            name: "terminal-connection",
            sessionId,
        };
    }
    if (parts.length === 4 && parts[2] === "user-input" && parts[3] !== undefined) {
        return {
            name: "user-input",
            requestId: decodeURIComponent(parts[3]),
            sessionId,
        };
    }
    if (parts.length === 4 && parts[2] === "external-tool-calls" && parts[3] !== undefined) {
        return {
            name: "external-tool-call",
            externalToolCallId: decodeURIComponent(parts[3]),
            sessionId,
        };
    }
    if (
        parts.length === 5 &&
        parts[2] === "workflows" &&
        parts[3] !== undefined &&
        parts[4] === "stop"
    ) {
        return {
            name: "workflow-stop",
            sessionId,
            workflowRunId: decodeURIComponent(parts[3]),
        };
    }
    if (parts.length === 4 && parts[2] === "background-processes" && parts[3] === "stop") {
        return { name: "background-processes-stop", sessionId };
    }
    if (parts.length === 4 && parts[2] === "background-processes" && parts[3] !== undefined) {
        const processSessionId = Number(parts[3]);
        if (!Number.isSafeInteger(processSessionId) || processSessionId <= 0) return undefined;
        return { name: "background-process", processSessionId, sessionId };
    }
    if (parts.length === 4 && parts[2] === "secrets" && parts[3] !== undefined) {
        return { name: "secret", secretId: decodeURIComponent(parts[3]), sessionId };
    }
    if (parts.length !== 3) return undefined;

    if (parts[2] === "abort") return { name: "abort", sessionId };
    if (parts[2] === "activity") return { name: "activity", sessionId };
    if (parts[2] === "archive") return { name: "archive", sessionId };
    if (parts[2] === "compact") return { name: "compact", sessionId };
    if (parts[2] === "current-provider-quota") {
        return { name: "current-provider-quota", sessionId };
    }
    if (parts[2] === "draft") return { name: "draft", sessionId };
    if (parts[2] === "effort") return { name: "effort", sessionId };
    if (parts[2] === "events") return { name: "events", sessionId };
    if (parts[2] === "external-tool-calls") {
        return { name: "external-tool-calls", sessionId };
    }
    if (parts[2] === "file") return { name: "file", sessionId };
    if (parts[2] === "files") return { name: "files", sessionId };
    if (parts[2] === "fork") return { name: "fork", sessionId };
    if (parts[2] === "goal") return { name: "goal", sessionId };
    if (parts[2] === "messages") return { name: "messages", sessionId };
    if (parts[2] === "model") return { name: "model", sessionId };
    if (parts[2] === "permissions") return { name: "permissions", sessionId };
    if (parts[2] === "reset") return { name: "reset", sessionId };
    if (parts[2] === "rewind") return { name: "rewind", sessionId };
    if (parts[2] === "secrets") return { name: "secrets", sessionId };
    if (parts[2] === "service-tier") return { name: "service-tier", sessionId };
    if (parts[2] === "shell") return { name: "shell", sessionId };
    if (parts[2] === "stream") return { name: "stream", sessionId };
    if (parts[2] === "state") return { name: "session-state", sessionId };
    if (parts[2] === "steer") return { name: "steer", sessionId };
    if (parts[2] === "transcript") return { name: "transcript", sessionId };
    if (parts[2] === "subagents") return { name: "subagents", sessionId };
    if (parts[2] === "usage") return { name: "usage", sessionId };
    if (parts[2] === "unarchive") return { name: "unarchive", sessionId };
    return undefined;
}

function isSessionMutation(routeName: string, method: string | undefined): boolean {
    return (
        (method === "PATCH" && routeName === "session") ||
        (method === "POST" &&
            [
                "abort",
                "activity",
                "archive",
                "background-processes-stop",
                "compact",
                "external-tool-call",
                "fork",
                "messages",
                "reorder",
                "reset",
                "rewind",
                "secrets",
                "shell",
                "steer",
                "unarchive",
            ].includes(routeName)) ||
        (method === "POST" && routeName === "workflow-stop") ||
        (method === "PUT" && routeName === "file") ||
        (["DELETE", "PUT"].includes(method ?? "") && routeName === "terminal-connection") ||
        (method === "DELETE" && routeName === "background-process") ||
        (["DELETE", "PATCH", "POST"].includes(method ?? "") && routeName === "goal") ||
        (method === "POST" && routeName === "user-input") ||
        (method === "DELETE" && routeName === "secret") ||
        (method === "PUT" && routeName === "draft") ||
        (method === "PATCH" &&
            ["effort", "model", "permissions", "service-tier"].includes(routeName))
    );
}

function isMutatingProtocolRequest(request: IncomingMessage): boolean {
    const url = new URL(request.url ?? "/", "http://unix");
    const route = matchRoute(url.pathname);
    if (route === undefined) return false;
    if (route.name === "config") return request.method === "PATCH";
    if (route.name === "debug-inspector") return request.method === "POST";
    if (route.name === "global-events-trim") return request.method === "POST";
    if (route.name === "happy-reload") return request.method === "POST";
    if (route.name === "secret-registrations") return request.method === "POST";
    if (route.name === "secret-registration") return request.method === "DELETE";
    if (route.name === "messages" && route.sessionId === undefined) {
        return request.method === "POST";
    }
    if (route.name === "sessions") return request.method === "POST";
    if (
        [
            "project",
            "project-archive",
            "project-avatar",
            "project-refresh",
            "project-reorder",
            "project-terminal",
            "project-terminals",
            "project-workspace",
            "project-workspace-archive",
            "project-workspace-reorder",
            "project-workspaces",
        ].includes(route.name)
    ) {
        return request.method !== "GET";
    }
    if (route.sessionId === undefined) return false;
    return isSessionMutation(route.name, request.method);
}

async function readJson<T>(request: IncomingMessage, maximumBytes?: number): Promise<T> {
    const body = (await readBuffer(request, maximumBytes)).toString("utf8");
    try {
        return (body.length === 0 ? {} : JSON.parse(body)) as T;
    } catch {
        throw new InvalidJsonBodyError();
    }
}

function hasOnlyObjectKeys(
    value: unknown,
    expectedKeys: readonly string[],
): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

function isReorderRequest(value: unknown): value is ReorderRequest {
    return (
        hasOnlyObjectKeys(value, ["afterId"]) &&
        (typeof value.afterId === "string" || value.afterId === null)
    );
}

async function readBuffer(request: IncomingMessage, maximumBytes?: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (maximumBytes !== undefined && receivedBytes > maximumBytes) {
            throw new RequestBodyTooLargeError();
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks);
}

function parseEntityVersion(value: string | readonly string[] | undefined): number | undefined {
    const selected = Array.isArray(value) ? value.at(-1) : value;
    if (selected === undefined) return undefined;
    const match = /^"?(\d+)"?$/u.exec(selected.trim());
    if (match === null) return undefined;
    const version = Number(match[1]);
    return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

function sessionMutationCanApply(
    request: IncomingMessage,
    response: ServerResponse,
    session: Pick<SessionEventSource, "events" | "snapshot">,
): boolean {
    const header = request.headers["if-match"];
    if (header === undefined) return true;
    const expected = parseExpectedEventId(header);
    if (expected === undefined) {
        sendJson(response, 400, { error: "The session version is invalid." });
        return false;
    }
    if (expected === session.events.lastEventId()) return true;
    sendJson(response, 409, {
        error: "The session changed before this action could be applied.",
        session: session.snapshot(),
    });
    return false;
}

function sessionMutationCompleted(
    session: Pick<SessionEventSource, "events">,
    mutationId: string | undefined,
): boolean {
    if (mutationId === undefined) return false;
    return (
        session.events.since(undefined)?.some((event) => {
            if (event.data === null || typeof event.data !== "object") return false;
            return (event.data as { mutationId?: unknown }).mutationId === mutationId;
        }) === true
    );
}

function parseExpectedEventId(value: string | readonly string[] | undefined): string | undefined {
    const selected = Array.isArray(value) ? value.at(-1) : value;
    if (selected === undefined) return undefined;
    const trimmed = selected.trim();
    const unquoted =
        trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
    return unquoted.length === 0 ? undefined : unquoted;
}

function requestMutationId(request: IncomingMessage): string | undefined {
    const value = request.headers["x-rig-mutation-id"];
    const selected = Array.isArray(value) ? value.at(-1) : value;
    return selected === undefined || selected.length === 0 || selected.length > 256
        ? undefined
        : selected;
}

class InvalidJsonBodyError extends Error {}

class RequestBodyTooLargeError extends Error {}

function isExternalToolCallResolution(value: unknown): value is ResolveExternalToolCallRequest {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (JSON.stringify(value).length > 1_048_576) return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.status === "failed") {
        if (candidate.error === null || typeof candidate.error !== "object") return false;
        const error = candidate.error as Record<string, unknown>;
        return (
            typeof error.message === "string" &&
            (error.code === undefined || typeof error.code === "string")
        );
    }
    if (candidate.status !== "completed") return false;
    if (candidate.content === undefined) return true;
    return (
        Array.isArray(candidate.content) &&
        candidate.content.every((block) => {
            if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
            const content = block as Record<string, unknown>;
            return content.type === "text"
                ? typeof content.text === "string"
                : content.type === "image" &&
                      typeof content.mediaType === "string" &&
                      typeof content.data === "string";
        })
    );
}

function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    session: SessionEventSource,
    after: string | undefined,
    sessionEventStreamLeases: Set<SessionEventStreamLease>,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): void {
    const cursor = request.headers["last-event-id"];
    const eventId = Array.isArray(cursor) ? cursor.at(-1) : cursor;
    const resumeFrom = eventId ?? after;
    const resumed = resumeFrom !== undefined;
    // A client attaching without a cursor is already caught up by the snapshot
    // in the hello frame, which reflects every event through `lastEventId`.
    // Replaying the log on top of it would send the conversation twice.
    const catchup = resumed ? session.events.since(resumeFrom) : [];
    if (catchup === undefined) {
        sendJson(response, 409, { error: "Event cursor not found" });
        return;
    }

    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    // The hello frame is written before the catch-up batch so a client can apply
    // everything that follows without asking the daemon anything else.
    const hello = sessionStreamHello(session, resumed, turnLimit, subagents);

    // A resumed client applies durable history first, then the current overlay.
    // If the connection drops mid-catch-up, its cursor advances only through
    // events it actually received, so the next attempt cannot skip anything.
    if (resumed) {
        for (const event of catchup) writeSseEvent(response, event);
    }
    writeSseHello(response, hello);

    const heartbeat = setInterval(() => {
        response.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();

    const unsubscribe = session.events.subscribe((event) => {
        writeSseEvent(response, event);
    });
    const lease = { session };
    sessionEventStreamLeases.add(lease);

    request.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        sessionEventStreamLeases.delete(lease);
        response.end();
    });
}

interface SessionEventSource {
    readonly events: SessionEventLog;
    activity: () => SessionActivity;
    partialMessage: () => SessionPartialMessage | undefined;
    snapshot: () => ProtocolSession;
    transcriptWindow: (turnLimit?: number) => SessionTranscriptWindow;
    usage: (events?: readonly SessionEvent[]) => SessionUsageSummary;
}

interface SessionEventStreamLease {
    readonly session: SessionEventSource;
}

function writeSseHello(response: ServerResponse, hello: SessionStreamHello): void {
    response.write("event: hello\n");
    response.write(`data: ${JSON.stringify(hello)}\n\n`);
}

function writeSseEvent(response: ServerResponse, event: SessionEvent): void {
    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * How many turns an opening frame should carry.
 *
 * A client may ask for fewer than the default, which is how a reader with a
 * short viewport avoids paying for history it will not draw. Anything that is
 * not a positive whole number is ignored in favour of the default rather than
 * failing the stream.
 */
function parseTurnLimit(value: string | null): number | undefined {
    if (value === null) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return undefined;
    return Math.min(parsed, SESSION_STREAM_TURN_LIMIT);
}

/**
 * The whole local catalog in one answer: projects, their workspaces, the active
 * sessions inside them, and the terminals attached to each group.
 *
 * This is the request-response half of sync. A client opens the live stream
 * first and loads this second, so anything that changes while it loads still
 * arrives on the stream with a cursor that says whether it is newer.
 */
function buildGroupCatalog(
    store: SessionStore,
    modelCatalog: ModelCatalog,
    identity: DaemonIdentity,
    sessionTerminals: SessionTerminalTracker,
): Omit<GlobalStreamHello, "cursor"> {
    const sessions = store
        .listActive()
        .map((summary) => sessionSummaryWithTerminalPresence(summary, sessionTerminals))
        .filter((summary) => !summary.archived);
    const projects = store.listProjects().filter((project) => project.archivedAt === undefined);
    const projectIds = new Set(projects.map((project) => project.id));
    const workspaces = store
        .listWorkspaces()
        .filter(
            (workspace) =>
                projectIds.has(workspace.projectId) &&
                workspace.archivedAt === undefined &&
                workspace.status !== "archiving" &&
                workspace.status !== "archived",
        );
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    return {
        catalog: modelCatalog,
        identity,
        protocolVersion: RIG_PROTOCOL_VERSION,
        projects,
        terminalGroups: store.remoteTerminals.groups().flatMap((group) =>
            !projectIds.has(group.scope.projectId) ||
            (group.scope.workspaceId !== undefined && !workspaceIds.has(group.scope.workspaceId))
                ? []
                : [
                      {
                          projectId: group.scope.projectId,
                          terminals: group.terminals,
                          ...(group.scope.workspaceId === undefined
                              ? {}
                              : { workspaceId: group.scope.workspaceId }),
                      },
                  ],
        ),
        sessions,
        sessionsComplete: true,
        workspaces,
    };
}

/**
 * Everything a client needs to start showing a session.
 *
 * A resuming client already holds the transcript and receives only the current
 * overlay; a client starting fresh receives the conversation itself. One
 * builder serves both the stream and the request-response bootstrap, so the two
 * cannot drift into describing the same session differently.
 */
function sessionStreamHello(
    session: SessionEventSource,
    resumed: boolean,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): SessionStreamHello {
    const lastEventId = session.events.lastEventId();
    const partial = session.partialMessage();
    // A resuming client already holds the transcript, so it is sent only to a
    // client attaching fresh. The window is cut on turn boundaries so a tool
    // result never arrives without the call it belongs to.
    const transcript = resumed ? undefined : session.transcriptWindow(turnLimit);
    const currentSession = session.snapshot();
    const full = resumed ? undefined : currentSession;
    // Materialise the durable log once. A long-running session may have many
    // events, and opening a stream must not allocate and walk three separate
    // copies merely to derive current side-state.
    const durableEvents = full === undefined ? undefined : session.events.all();
    const usage =
        full === undefined || durableEvents === undefined
            ? undefined
            : session.usage(durableEvents);
    const snapshot =
        full === undefined || transcript === undefined
            ? undefined
            : {
                  ...full,
                  shellCommands: session.events.shellCommandStates(),
                  subagents,
                  snapshot: { ...full.snapshot, messages: transcript.messages },
              };
    const hello: SessionStreamHello = {
        activity: session.activity(),
        resumed,
        ...(resumed
            ? {
                  current: {
                      ...(currentSession.draft === undefined
                          ? {}
                          : { draft: currentSession.draft }),
                      ...(currentSession.draftUpdatedAt === undefined
                          ? {}
                          : { draftUpdatedAt: currentSession.draftUpdatedAt }),
                      ...(currentSession.git === undefined ? {} : { git: currentSession.git }),
                      ...(currentSession.interruption === undefined
                          ? {}
                          : { interruption: currentSession.interruption }),
                      ...(currentSession.externalTools === undefined
                          ? {}
                          : { externalTools: currentSession.externalTools }),
                      mcpServers: currentSession.mcpServers,
                      ...(currentSession.pendingExternalToolCalls === undefined
                          ? {}
                          : {
                                pendingExternalToolCalls: currentSession.pendingExternalToolCalls,
                            }),
                      projectSecretIds: currentSession.projectSecretIds,
                      secretIds: currentSession.secretIds,
                      sessionSecretIds: currentSession.sessionSecretIds,
                      ...(currentSession.skills === undefined
                          ? {}
                          : { skills: currentSession.skills }),
                      ...(currentSession.sessionTokenCount === undefined
                          ? {}
                          : { sessionTokenCount: currentSession.sessionTokenCount }),
                      ...(currentSession.titleError === undefined
                          ? {}
                          : { titleError: currentSession.titleError }),
                      titleStatus: currentSession.titleStatus,
                      ...(currentSession.workflows === undefined
                          ? {}
                          : { workflows: currentSession.workflows }),
                      ...(currentSession.workflowsEnabled === undefined
                          ? {}
                          : { workflowsEnabled: currentSession.workflowsEnabled }),
                  },
              }
            : {}),
        ...(full === undefined || usage === undefined
            ? {}
            : {
                  usage: {
                      currentProviderId: full.providerId,
                      groups: usage.groups,
                      observedQuota: usage.observedQuota,
                      quotas: [...session.events.latestProviderQuotas().entries()].map(
                          ([providerId, quota]) => ({ providerId, quota }),
                      ),
                      sessionTokenCount: usage.sessionTokenCount,
                      ...(usage.currentContext === undefined
                          ? {}
                          : { context: usage.currentContext }),
                  },
              }),
        ...(snapshot === undefined || transcript === undefined
            ? {}
            : { session: snapshot, transcript }),
        ...(partial === undefined ? {} : { partial }),
        ...(lastEventId === undefined ? {} : { lastEventId }),
    };
    return hello;
}

/**
 * The request-response bootstrap has a dedicated transcript field, so its
 * current-state snapshot carries no second copy of conversation history.
 *
 * The legacy session stream keeps its original complete hello for the terminal;
 * this projection is only for rig-connect's `/state` endpoint.
 */
function sessionStateHello(
    session: SessionEventSource,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): SessionStreamHello {
    const hello = sessionStreamHello(session, false, turnLimit, subagents);
    if (hello.session === undefined) return hello;
    const { contextMessages: _contextMessages, ...agentSnapshot } = hello.session.snapshot;
    return {
        ...hello,
        session: {
            ...hello.session,
            // Completed commands are transcript history. Only commands that are
            // still executing are part of the current state bootstrap.
            shellCommands: (hello.session.shellCommands ?? []).filter(
                (command) => command.status === "running",
            ),
            snapshot: { ...agentSnapshot, messages: [] },
        },
    };
}
