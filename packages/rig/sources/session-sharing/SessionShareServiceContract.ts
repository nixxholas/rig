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
    SetSessionShareToolOutputRequest,
    StopSessionShareRequest,
} from "../protocol/index.js";

/**
 * Daemon API boundary for session sharing.
 *
 * The daemon implements it over the real Murmur shared-session transport.
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
    setToolOutput(
        sessionId: string,
        request: SetSessionShareToolOutputRequest,
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
