import type { IdentityKeyPair, IdentityProfile, MurmurStore } from "@slopus/murmur";
import type {
    AnswerMurmurFriendRequestRequest,
    AnswerMurmurFriendRequestResponse,
    DeleteMurmurAccountResponse,
    GetMurmurAccountResponse,
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

export interface MurmurLifecycleStore extends MurmurStore {
    close(): void | Promise<void>;
    deleteDatabaseFiles(): void | Promise<void>;
}

export interface StoredMurmurAccount {
    readonly identity: IdentityKeyPair;
    readonly profile: IdentityProfile;
}

export interface MurmurServiceContract {
    getAccount(): Promise<GetMurmurAccountResponse>;
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
