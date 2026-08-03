import type {
    IdentityKeyPair,
    IdentityProfile,
    MurmurClient,
    MurmurStore,
    ReceivedEvent,
} from "@slopus/murmur";
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

/**
 * Live Murmur primitives a higher-level protocol needs while the service runs.
 *
 * Shared sessions build their own MLS group state on top of the same account
 * identity, client, and store, so they must never open a second account.
 */
export interface MurmurRuntimeHandle {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly store: MurmurStore;
}

/**
 * Consumes one received event before the friendship inbox sees it.
 *
 * A router returns `true` once it owns the event, in which case it has already
 * advanced the relay cursor inside its own durable transaction.
 */
export type MurmurEventRouter = (received: ReceivedEvent) => Promise<boolean>;

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
    /** The live runtime, or `undefined` while the Murmur service is stopped. */
    runtime(): MurmurRuntimeHandle | undefined;
    /** Observe the runtime appearing and disappearing as the service starts and stops. */
    onRuntimeChanged(listener: (runtime: MurmurRuntimeHandle | undefined) => void): () => void;
    /** Route events to a higher-level protocol before the friendship inbox. */
    registerEventRouter(router: MurmurEventRouter): () => void;
    close(): Promise<void>;
}
