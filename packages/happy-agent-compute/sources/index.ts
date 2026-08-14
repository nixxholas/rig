/** Public surface of `@slopus/happy-agent-compute`. */

export { type Compute } from "./Compute.js";
export {
    computeHostPolicySchema,
    EMPTY_COMPUTE_HOST_POLICY,
    type ComputeHostPolicy,
} from "./ComputeHostPolicy.js";
export { type ComputeConfigOf, type ComputeProvider } from "./ComputeProvider.js";
export { ComputeProviders } from "./ComputeProviders.js";
export {
    type ComputeDirectoryPage,
    type ComputeDirectoryPageOptions,
    type ComputeFileStat,
    type ComputeFileSystem,
    type ComputeReadOptions,
} from "./ComputeFileSystem.js";
export {
    allowEverything,
    assertComputePermissions,
    computeNetworkPermissionsSchema,
    computePermissions,
    computePermissionModeSchema,
    computePermissionsSchema,
    DEFAULT_COMPUTE_PERMISSION_MODE,
    type ComputeNetworkPermissions,
    type ComputePermissionMode,
    type ComputePermissions,
} from "./ComputePermissions.js";
export {
    type ComputeRunOptions,
    type ComputeRunResult,
    type ComputeSessionActivity,
    type ComputeSessionExit,
    type ComputeSessionReadOptions,
    type ComputeSessionSnapshot,
    type ComputeSessionStatus,
    type ComputeShell,
} from "./ComputeShell.js";
export {
    createJustBashCompute,
    type JustBashComputeOptions,
    type JustBashFolderComputeOptions,
    type JustBashMemoryComputeOptions,
} from "./justBash/createJustBashCompute.js";
export {
    createJustBashComputeFromFileSystem,
    type JustBashFileSystemCompute,
    type JustBashFileSystemComputeOptions,
} from "./justBash/createJustBashComputeFromFileSystem.js";
export {
    justBashComputeConfigSchema,
    justBashComputeProvider,
    type JustBashComputeConfig,
} from "./justBash/justBashComputeProvider.js";

// The host compute: the real filesystem and shell of the machine the agent runs on.
export * from "./host/index.js";
export {
    hostComputeConfigSchema,
    hostComputeProvider,
    type HostComputeConfig,
} from "./host/hostComputeProvider.js";

// The Docker compute: a filesystem and shell inside a container.
export * from "./docker/index.js";

// Process lifecycle machinery the backends share.
export * from "./processes/index.js";

// Command sandbox: the filesystem and network boundary a restricted command runs inside.
export * from "./sandbox/index.js";

// Managed network: the command-scoped proxy and bridge that carry allowed egress.
export * from "./network/index.js";
