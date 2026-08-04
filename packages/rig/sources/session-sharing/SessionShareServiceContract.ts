import type {
    AddSessionShareMemberRequest,
    CreateSessionShareRequest,
    GetSessionShareHealthResponse,
    GetSessionSharePeerActivityResponse,
    GetSessionShareReplicaHistoryResponse,
    ListSessionShareReplicaCapabilitiesResponse,
    ListSessionShareReplicasResponse,
    PostSessionShareFriendMessageRequest,
    PostSessionShareFriendMessageResponse,
    RevokeSessionShareMemberRequest,
    SessionShareOwnerResponse,
    SetSessionShareFriendMessagesRequest,
    SetSessionShareMemberCapabilitiesRequest,
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
    /**
     * Replace one member's capabilities with the complete set the owner asked for.
     *
     * A full set rather than a delta: two owner clients editing at once would
     * otherwise resolve to whichever delta landed last, which on a security
     * boundary means a permission nobody chose. Returns the whole owner response
     * so a client reconciles members and capabilities from one frame.
     */
    setMemberCapabilities(
        sessionId: string,
        shareMemberId: string,
        request: SetSessionShareMemberCapabilitiesRequest,
    ): Promise<SessionShareOwnerResponse>;
    /** One bounded page of what peers of this session have actually done. */
    peerActivity(
        sessionId: string,
        after?: string,
    ): GetSessionSharePeerActivityResponse | undefined;
    /** What this machine's own replica of somebody else's share may do. */
    replicaCapabilities(shareId: string): ListSessionShareReplicaCapabilitiesResponse | undefined;
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
