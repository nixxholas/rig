export {
    P2pCredentialReplicator,
    replicateCredentialSnapshotToP2pPeer,
    type P2pCredentialReplicatorOptions,
} from "./P2pCredentialReplicator.js";
export {
    P2pCredentialRuntimeRegistry,
    type P2pCredentialRuntimeRegistryOptions,
} from "./P2pCredentialRuntimeRegistry.js";
export {
    P2pCredentialStore,
    P2pCredentialVersionConflictError,
    type P2pCredentialDatabase,
    type P2pCredentialReplaceResult,
    type P2pCredentialStoreOptions,
} from "./P2pCredentialStore.js";
export {
    buildOwnerProviderScope,
    type CredentialVisibility,
    type OwnerProviderScope,
    type ProviderCredentialProvenance,
    type ProviderCredentialSource,
} from "./buildOwnerProviderScope.js";
export {
    createLocalCredentialSnapshot,
    P2P_CREDENTIAL_AUTH_FILE_MAX_BYTES,
    type CreateLocalCredentialSnapshotOptions,
} from "./createLocalCredentialSnapshot.js";
