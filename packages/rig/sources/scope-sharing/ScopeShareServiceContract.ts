import type {
    AddScopeShareMemberRequest,
    CreateScopeShareRequest,
    GetScopeShareHealthResponse,
    GetScopeShareReplicaResponse,
    GetScopeShareSessionHistoryResponse,
    ListScopeShareReplicasResponse,
    RevokeScopeShareMemberRequest,
    ScopeShareOwnerResponse,
    ScopeShareScopeKind,
    StopScopeShareRequest,
} from "../protocol/index.js";

/** What a scope route names: one workspace, or a whole project. */
export interface ScopeShareTarget {
    readonly scopeId: string;
    readonly scopeKind: ScopeShareScopeKind;
}

/**
 * Daemon API boundary for sharing a workspace or a project.
 *
 * The daemon implements it over the same Murmur shared-session transport that
 * carries session shares.
 */
export interface ScopeShareServiceContract {
    getOwner(scope: ScopeShareTarget): ScopeShareOwnerResponse | undefined;
    create(
        scope: ScopeShareTarget,
        request: CreateScopeShareRequest,
    ): Promise<ScopeShareOwnerResponse>;
    add(
        scope: ScopeShareTarget,
        request: AddScopeShareMemberRequest,
    ): Promise<ScopeShareOwnerResponse>;
    revoke(
        scope: ScopeShareTarget,
        shareMemberId: string,
        request: RevokeScopeShareMemberRequest,
    ): Promise<ScopeShareOwnerResponse>;
    stop(scope: ScopeShareTarget, request: StopScopeShareRequest): Promise<ScopeShareOwnerResponse>;
    stopForArchivedWorkspace(workspaceId: string): Promise<void>;
    stopForArchivedProject(projectId: string): Promise<void>;
    health(shareId: string): GetScopeShareHealthResponse | undefined;
    listReplicas(): ListScopeShareReplicasResponse;
    replica(shareId: string, after?: string): GetScopeShareReplicaResponse | undefined;
    replicaSessionHistory(
        shareId: string,
        sessionId: string,
        after?: string,
    ): GetScopeShareSessionHistoryResponse | undefined;
}
