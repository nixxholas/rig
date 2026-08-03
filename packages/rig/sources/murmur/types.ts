import type { IdentityKeyPair, IdentityProfile, MurmurStore } from "@slopus/murmur";
import type {
    AnswerMurmurFriendRequestRequest,
    AnswerMurmurFriendRequestResponse,
    DeleteMurmurAccountResponse,
    GetMurmurAccountResponse,
    GetMurmurFriendsResponse,
    ListMurmurContactsResponse,
    ListMurmurFriendRequestsResponse,
    SendMurmurFriendRequestRequest,
    SendMurmurFriendRequestResponse,
    SignupMurmurAccountRequest,
    SignupMurmurAccountResponse,
    StartMurmurServiceRequest,
    StartMurmurServiceResponse,
    StopMurmurServiceResponse,
} from "../protocol/MurmurProtocol.js";

export interface MurmurPagedStore extends MurmurStore {
    listPage(
        prefix: string,
        after: string | undefined,
        limit: number,
    ): Promise<ReadonlyMap<string, Uint8Array>>;
}

export interface MurmurLifecycleStore extends MurmurPagedStore {
    close(): void | Promise<void>;
    deleteDatabaseFiles(): void | Promise<void>;
}

export interface StoredMurmurAccount {
    readonly identity: IdentityKeyPair;
    readonly profile: IdentityProfile;
}

export interface MurmurServiceContract {
    getAccount(): Promise<GetMurmurAccountResponse>;
    getFriends(): Promise<GetMurmurFriendsResponse>;
    signup(request: SignupMurmurAccountRequest): Promise<SignupMurmurAccountResponse>;
    start(request?: StartMurmurServiceRequest): Promise<StartMurmurServiceResponse>;
    stop(): Promise<StopMurmurServiceResponse>;
    deleteAccount(): Promise<DeleteMurmurAccountResponse>;
    sendFriendRequest(
        request: SendMurmurFriendRequestRequest,
    ): Promise<SendMurmurFriendRequestResponse>;
    listFriendRequests(): Promise<ListMurmurFriendRequestsResponse>;
    answerFriendRequest(
        id: string,
        request: AnswerMurmurFriendRequestRequest,
    ): Promise<AnswerMurmurFriendRequestResponse>;
    listContacts(): Promise<ListMurmurContactsResponse>;
    close(): Promise<void>;
}
