import type {
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateProjectWorkspaceRequest,
    CreateSessionRequest,
    Project,
    ProjectWorkspace,
    RegisterSecretRequest,
    SecretSummary,
    SubagentSummary,
    SessionSummary,
} from "../protocol/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { ExternalToolCall } from "../external-tools/index.js";
import type { GlobalEventQueue } from "./GlobalEventQueue.js";
import type { ProjectAvatarAsset } from "./ProjectRepository.js";

export interface SessionStore {
    readonly globalEventQueue: GlobalEventQueue;
    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
    ): InMemorySession | undefined;
    changeEffort(sessionId: string, request: ChangeEffortRequest): InMemorySession | undefined;
    changeModel(sessionId: string, request: ChangeModelRequest): InMemorySession | undefined;
    changeServiceTier(
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): InMemorySession | undefined;
    create(request: CreateSessionRequest): InMemorySession;
    createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspace | undefined>;
    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
    ): InMemorySession | undefined;
    fork(sessionId: string): InMemorySession | undefined;
    get(sessionId: string): InMemorySession | undefined;
    getProject(projectId: string): Project | undefined;
    getProjectAvatar(hash: string): Promise<ProjectAvatarAsset | undefined>;
    getWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined;
    list(options?: { limit?: number }): readonly SessionSummary[];
    listExternalToolCalls(options?: {
        limit?: number;
        status?: ExternalToolCall["status"];
    }): readonly ExternalToolCall[];
    listSubagents(parentSessionId: string): readonly SubagentSummary[];
    listSecrets(): readonly SecretSummary[];
    listProjects(): readonly Project[];
    listWorkspaces(projectId?: string): readonly ProjectWorkspace[];
    renameProject(projectId: string, name: string): Project | undefined;
    renameWorkspace(
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined;
    refreshProject(projectId: string): Project | undefined;
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
    clearProjectAvatar(projectId: string): Project | undefined;
    registerSecret(request: RegisterSecretRequest): SecretSummary;
    unregisterSecret(secretId: string): boolean;
}
