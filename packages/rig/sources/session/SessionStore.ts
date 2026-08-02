import type {
    Attachment,
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    GetTimelineRequest,
    GitRepositoryFacts,
    Project,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    ReorderRequest,
    RegisterSecretRequest,
    SecretSummary,
    SubagentSummary,
    SessionSummary,
    TimelineAgent,
} from "../protocol/index.js";
import type { AgentTreeUsage } from "../agent/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { ExternalToolCall } from "../external-tools/index.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import type { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import type { ProjectAvatarAsset, ProjectSessionSettings } from "../project/ProjectRepository.js";
import type { ProjectRemoteTerminalStore } from "../terminal/index.js";
import type { DurableUserInputCall } from "../user-input/index.js";
import type { PresenceStore } from "../presence/index.js";
import type { SlotEntryStore } from "../slots/index.js";
import type { WebappStore } from "../webapps/index.js";

export interface SessionStore {
    readonly globalEventQueue: GlobalEventQueue;
    /** The ephemeral stream every local client follows. Never persisted. */
    readonly liveEvents: LiveGlobalEventQueue;
    /** Where the user is right now, and every presence they can switch to. */
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    /** Agent-authored content plugged into the fixed Happy UI slots. */
    readonly slots: SlotEntryStore;
    /** Imported, versioned webapps rig serves as static files. */
    readonly webapps: WebappStore;
    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): InMemorySession | undefined;
    attachment(sessionId: string, attachmentId: string): Attachment | undefined;
    changeEffort(sessionId: string, request: ChangeEffortRequest): InMemorySession | undefined;
    changeModel(sessionId: string, request: ChangeModelRequest): InMemorySession | undefined;
    changeServiceTier(
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): InMemorySession | undefined;
    create(request: CreateSessionRequest): InMemorySession;
    createWithId(id: string, request: CreateSessionRequest): InMemorySession;
    createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined>;
    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): InMemorySession | undefined;
    fork(sessionId: string, targetSessionId?: string): InMemorySession | undefined;
    findByAgentId(agentId: string): InMemorySession | undefined;
    get(sessionId: string): InMemorySession | undefined;
    getProject(projectId: string): Project | undefined;
    getProjectAvatar(hash: string): Promise<ProjectAvatarAsset | undefined>;
    getWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined;
    list(options?: { limit?: number }): readonly SessionSummary[];
    /** Every explicitly unarchived primary session, with no default limit. */
    listActive(options?: { limit?: number }): readonly SessionSummary[];
    listExternalToolCalls(options?: {
        limit?: number;
        status?: ExternalToolCall["status"];
    }): readonly ExternalToolCall[];
    listDurableUserInputs(): readonly DurableUserInputCall[];
    listSubagents(parentSessionId: string): readonly SubagentSummary[];
    queryAgentTreeUsage(sessionId: string): AgentTreeUsage | undefined;
    listSecrets(): readonly SecretSummary[];
    applyGitFacts(
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): void;
    listProjects(): readonly Project[];
    listWorkspaces(projectId?: string): readonly ProjectWorkspace[];
    renameProject(
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined;
    queryProjectSettings(cwd: string): ProjectSessionSettings | undefined;
    renameWorkspace(
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): ProjectWorkspace | undefined;
    refreshProject(projectId: string): Project | undefined;
    reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Project | undefined;
    reorderSession(sessionId: string, request: ReorderRequest): InMemorySession | undefined;
    reorderWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined;
    archiveProject(projectId: string, expectedVersion?: number): Promise<Project | undefined>;
    unarchiveProject(projectId: string): Project | undefined;
    archiveWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined>;
    setProjectAvatar(
        projectId: string,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined>;
    setProjectSettings(
        projectId: string,
        settings: ProjectSettingsUpdate,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined;
    clearProjectAvatar(projectId: string): Project | undefined;
    registerSecret(request: RegisterSecretRequest): SecretSummary;
    /** The agents a scope covers and when each of them worked, waited, or asked. */
    timeline(request: GetTimelineRequest): readonly TimelineAgent[];
    unregisterSecret(secretId: string): boolean;
}
