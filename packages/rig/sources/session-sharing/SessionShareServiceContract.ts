import type {
    AddSessionShareMemberRequest,
    CreateSessionShareRequest,
    GetSessionShareHealthResponse,
    GetSessionShareReplicaHistoryResponse,
    ListSessionShareReplicasResponse,
    PostSessionShareFriendMessageRequest,
    PostSessionShareFriendMessageResponse,
    RevokeSessionShareMemberRequest,
    SessionShareOwnerResponse,
    SetSessionShareFriendMessagesRequest,
    StopSessionShareRequest,
} from "../protocol/index.js";

/**
 * Daemon API boundary for session sharing.
 *
 * The real runtime supplies this only after the Murmur session transport adapter is available.
 */
export interface SessionShareServiceContract {
    getOwner(sessionId: string): SessionShareOwnerResponse | undefined;
    create(
        sessionId: string,
        request: CreateSessionShareRequest,
    ): Promise<SessionShareOwnerResponse>;
    add(
        sessionId: string,
        request: AddSessionShareMemberRequest,
    ): Promise<SessionShareOwnerResponse>;
    revoke(
        sessionId: string,
        shareMemberId: string,
        request: RevokeSessionShareMemberRequest,
    ): Promise<SessionShareOwnerResponse>;
    stop(sessionId: string, request: StopSessionShareRequest): Promise<SessionShareOwnerResponse>;
    stopForArchivedSession(sessionId: string): Promise<void>;
    setFriendMessages(
        sessionId: string,
        request: SetSessionShareFriendMessagesRequest,
    ): Promise<SessionShareOwnerResponse>;
    health(shareId: string): GetSessionShareHealthResponse | undefined;
    listReplicas(): ListSessionShareReplicasResponse;
    replicaHistory(
        shareId: string,
        after?: string,
    ): GetSessionShareReplicaHistoryResponse | undefined;
    postFriendMessage(
        request: PostSessionShareFriendMessageRequest,
    ): Promise<PostSessionShareFriendMessageResponse>;
}
