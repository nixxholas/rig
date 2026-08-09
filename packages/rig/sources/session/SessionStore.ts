import type {
    Attachment,
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangeServiceTierRequest,
    CreateDocumentRequest,
    CreateFolderItemRequest,
    CreateFolderRequest,
    CreateProjectWorkspaceRequest,
    CreateRemoteProjectRequest,
    CreateSessionRequest,
    Document,
    DocumentCreatedBy,
    DocumentUpdatePage,
    Folder,
    FolderItem,
    ListFoldersResponse,
    ListDocumentUpdatesRequest,
    GetTimelineRequest,
    GitRepositoryFacts,
    MoveFolderItemRequest,
    MoveFolderRequest,
    Project,
    ProjectCreator,
    ProjectSettingsUpdate,
    ProjectWorkspace,
    RegisterProjectRequest,
    ReorderRequest,
    RegisterSecretRequest,
    SecretSummary,
    SubagentSummary,
    SessionSummary,
    SharedFolderState,
    TimelineAgent,
    TransferSessionRequest,
    TransferSessionResponse,
    UpdateSecretRequest,
    UpdateFolderRequest,
    WriteDocumentRequest,
} from "../protocol/index.js";
import type { AgentTreeUsage } from "../agent/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import type { SecretAttachmentScope } from "../secrets/index.js";
import type { SpecialSecretKind, SpecialSecretRegistration } from "../secrets/index.js";
import type { ExternalToolCall } from "../external-tools/index.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import type { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";
import type { ProjectAvatarAsset, ProjectSessionSettings } from "../project/ProjectRepository.js";
import type { ProjectRemoteTerminalStore } from "../terminal/index.js";
import type { DurableUserInputCall } from "../user-input/index.js";
import type { PresenceStore } from "../presence/index.js";
import type { SlotEntryStore } from "../slots/index.js";
import type { AppletStore } from "../applets/index.js";
import type { WorkletStore } from "../worklets/index.js";

/** Internal server-side attributes for a new root session. */
export interface SessionCreationOptions {
    ownerInstanceId?: string;
    profileId?: string;
}

export interface SessionStore {
    /** Stable identity of this Rig installation. */
    readonly localInstanceId: string;
    /** Stable identity for this initialized Rig data generation. */
    readonly dataEpoch: string;
    /** Schema version observed from the initialized store after migration. */
    readonly dataSchemaVersion: number;
    readonly globalEventQueue: GlobalEventQueue;
    /** The ephemeral stream every local client follows. Never persisted. */
    readonly liveEvents: LiveGlobalEventQueue;
    /** Where the user is right now, and every presence they can switch to. */
    readonly presence: PresenceStore;
    readonly remoteTerminals: ProjectRemoteTerminalStore;
    /** Agent- and plugin-authored content plugged into the fixed Happy UI slots. */
    readonly slots: SlotEntryStore;
    /** Imported, versioned applets rig serves as static files. */
    readonly applets: AppletStore;
    /** Installed, versioned worklets: the background compute rig keeps running. */
    readonly worklets: WorkletStore;
    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined>;
    attachment(sessionId: string, attachmentId: string): Promise<Attachment | undefined>;
    changeEffort(
        sessionId: string,
        request: ChangeEffortRequest,
    ): Promise<InMemorySession | undefined>;
    changeModel(
        sessionId: string,
        request: ChangeModelRequest,
    ): Promise<InMemorySession | undefined>;
    changeServiceTier(
        sessionId: string,
        request: ChangeServiceTierRequest,
    ): Promise<InMemorySession | undefined>;
    create(
        request: CreateSessionRequest,
        options?: SessionCreationOptions,
    ): Promise<InMemorySession>;
    createWithId(
        id: string,
        request: CreateSessionRequest,
        options?: SessionCreationOptions,
    ): Promise<InMemorySession>;
    createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string },
    ): Promise<ProjectWorkspace | undefined>;
    createRemoteProject(
        request: CreateRemoteProjectRequest,
        options?: { createdBy?: ProjectCreator; githubToken?: string; mutationId?: string },
    ): Promise<Project>;
    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope,
        mutationId?: string,
    ): Promise<InMemorySession | undefined>;
    fork(sessionId: string, targetSessionId?: string): Promise<InMemorySession | undefined>;
    findByAgentId(agentId: string): Promise<InMemorySession | undefined>;
    get(sessionId: string): Promise<InMemorySession | undefined>;
    getProject(projectId: string): Promise<Project | undefined>;
    getProjectAvatar(hash: string): Promise<ProjectAvatarAsset | undefined>;
    getWorkspace(projectId: string, workspaceId: string): Promise<ProjectWorkspace | undefined>;
    list(options?: { limit?: number }): Promise<readonly SessionSummary[]>;
    /** Every explicitly unarchived primary session, with no default limit. */
    listActive(options?: { limit?: number }): Promise<readonly SessionSummary[]>;
    /** Sessions already resident in memory; implementations must not hydrate storage to answer. */
    loadedSessions(): readonly InMemorySession[];
    listExternalToolCalls(options?: {
        limit?: number;
        status?: ExternalToolCall["status"];
    }): Promise<readonly ExternalToolCall[]>;
    listDurableUserInputs(): Promise<readonly DurableUserInputCall[]>;
    listSubagents(parentSessionId: string): Promise<readonly SubagentSummary[]>;
    queryAgentTreeUsage(sessionId: string): Promise<AgentTreeUsage | undefined>;
    listSecrets(): Promise<readonly SecretSummary[]>;
    applyGitFacts(
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): Promise<void>;
    /** The whole folder tree, every parent ahead of what is nested under it. */
    listFolders(): Promise<readonly Folder[]>;
    folderCatalog(): Promise<ListFoldersResponse>;
    getFolder(folderId: string): Promise<Folder | undefined>;
    getFolderItem(itemId: string): Promise<FolderItem | undefined>;
    createFolderItem(folderId: string, request: CreateFolderItemRequest): Promise<FolderItem>;
    moveFolderItem(
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion?: number,
    ): Promise<FolderItem | undefined>;
    archiveFolderItem(
        itemId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<FolderItem | undefined>;
    createFolder(request: CreateFolderRequest): Promise<Folder>;
    updateFolder(
        folderId: string,
        request: UpdateFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined>;
    moveFolder(
        folderId: string,
        request: MoveFolderRequest,
        expectedVersion?: number,
    ): Promise<Folder | undefined>;
    /** Puts a folder away together with everything nested under it. */
    archiveFolder(
        folderId: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Folder | undefined>;
    sharedFolderState(rootFolderId: string): Promise<SharedFolderState>;
    sharedFolderGroup(folderId: string): Promise<string | undefined>;
    sharedFolderRoot(groupId: string): Promise<string | undefined>;
    assertFolderShareable(folderId: string): Promise<void>;
    markFolderShared(folderId: string, groupId: string): Promise<Folder>;
    applySharedFolderState(groupId: string, state: SharedFolderState): Promise<Folder>;
    getDocument(documentId: string): Promise<Document | undefined>;
    createDocument(request: CreateDocumentRequest, createdBy: DocumentCreatedBy): Promise<Document>;
    writeDocument(
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Promise<Document | undefined>;
    documentUpdates(
        documentId: string,
        request: ListDocumentUpdatesRequest,
    ): Promise<DocumentUpdatePage | undefined>;
    /** Files one chat into a folder, or takes it back out into Unsorted with `null`. */
    setSessionFolder(
        sessionId: string,
        folderId: string | null,
        afterId?: string | null,
        mutationId?: string,
    ): Promise<InMemorySession | undefined>;
    sessionScopeMutationApplied(sessionId: string, mutationId: string): Promise<boolean>;
    listProjects(): Promise<readonly Project[]>;
    listWorkspaces(projectId?: string): Promise<readonly ProjectWorkspace[]>;
    registerProject(request: RegisterProjectRequest): Promise<Project>;
    renameProject(
        projectId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<Project | undefined>;
    queryProjectSettings(cwd: string): Promise<ProjectSessionSettings | undefined>;
    renameWorkspace(
        projectId: string,
        workspaceId: string,
        name: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Promise<ProjectWorkspace | undefined>;
    refreshProject(projectId: string): Promise<Project | undefined>;
    reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<Project | undefined>;
    reorderSession(
        sessionId: string,
        request: ReorderRequest,
    ): Promise<InMemorySession | undefined>;
    reorderWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Promise<ProjectWorkspace | undefined>;
    archiveProject(projectId: string, expectedVersion?: number): Promise<Project | undefined>;
    unarchiveProject(projectId: string): Promise<Project | undefined>;
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
    ): Promise<Project | undefined>;
    clearProjectAvatar(projectId: string): Promise<Project | undefined>;
    registerSecret(request: RegisterSecretRequest): Promise<SecretSummary>;
    registerSpecialSecret(request: SpecialSecretRegistration): Promise<SecretSummary>;
    resolveSpecialSecret(kind: SpecialSecretKind): NodeJS.ProcessEnv;
    refreshSessionGitCredential(
        sessionId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<boolean>;
    /** The agents a scope covers and when each of them worked, waited, or asked. */
    timeline(request: GetTimelineRequest): Promise<readonly TimelineAgent[]>;
    transferSession(
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse | undefined>;
    unregisterSecret(secretId: string): Promise<boolean>;
    unregisterSpecialSecret(kind: SpecialSecretKind): Promise<boolean>;
    updateSecret(
        secretId: string,
        request: UpdateSecretRequest,
    ): Promise<SecretSummary | undefined>;
}
