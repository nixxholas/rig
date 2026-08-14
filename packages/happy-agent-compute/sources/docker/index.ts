/** The Docker compute backend: a filesystem and shell inside a container. */

export { createDockerCompute, type DockerComputeOptions } from "./createDockerCompute.js";
export { createDockerFileSystem } from "./createDockerFileSystem.js";
export { createDockerShell, type DockerShellOptions } from "./createDockerShell.js";
export { DockerEnvironment } from "./DockerEnvironment.js";
export {
    dockerExecutionConfigSchema,
    dockerHostPolicyConfigSchema,
    dockerMountConfigSchema,
    type DockerExecutionConfig,
    type DockerMountConfig,
} from "./DockerExecutionConfig.js";
export {
    createDockerComputeProvider,
    dockerComputeProvider,
    type DockerClientFactory,
} from "./dockerComputeProvider.js";

// Configuration helpers a caller uses to build and validate a Docker configuration.
export { resolveDockerExecutionConfig } from "./impl/resolveDockerExecutionConfig.js";
export { validateDockerExecutionConfig } from "./impl/validateDockerExecutionConfig.js";

// Path resolution and metadata, mostly for the backend but useful to a caller too.
export { assertDockerReadPath } from "./impl/assertDockerReadPath.js";
export { assertDockerWritePath } from "./impl/assertDockerWritePath.js";
export { resolveDockerPath } from "./impl/resolveDockerPath.js";
export { resolveDockerBindMountPath } from "./impl/resolveDockerBindMountPath.js";
export { parseDockerPathStat } from "./impl/parseDockerPathStat.js";
export { formatDockerTouchTimestamp } from "./impl/formatDockerTouchTimestamp.js";
export { readDockerEnvironmentVariableNames } from "./impl/readDockerEnvironmentVariableNames.js";
export { isDockerNotFoundError } from "./impl/isDockerNotFoundError.js";
export { appendCappedChunk } from "./impl/appendCappedChunk.js";

// The restricted-command sandbox and managed-network machinery inside the container.
export { runDockerExec, type DockerExecResult } from "./impl/runDockerExec.js";
export { prepareDockerSandbox, type PreparedDockerSandbox } from "./impl/prepareDockerSandbox.js";
export {
    createDockerNetworkRelayScript,
    createDockerSandboxCommand,
} from "./impl/createDockerSandboxCommand.js";
export { DOCKER_PROTECTED_PATH_MONITOR_SCRIPT } from "./impl/dockerProtectedPathMonitorScript.js";
export {
    DOCKER_NETWORK_BRIDGE_DIRECTORY,
    prepareDockerNetworkBridgeHostRoot,
} from "./impl/prepareDockerNetworkBridgeHostRoot.js";
export { prepareDockerNetworkBridgeContainerRoot } from "./impl/prepareDockerNetworkBridgeContainerRoot.js";
export {
    cleanupDockerNetworkPolicyPlaceholder,
    loadDockerProjectManagedNetworkPolicyState,
    parseDockerNetworkPolicyOutput,
    type DockerProjectNetworkPolicyFile,
    type DockerProjectManagedNetworkPolicyState,
    type ParseDockerProjectNetworkConfig,
} from "./impl/loadDockerProjectManagedNetworkPolicy.js";
export {
    dockerNetworkPolicyFileNames,
    dockerProtectedProjectFileNames,
    dockerReadableDirectories,
    resolveDockerPrivateDirectories,
    snapshotDockerHostPolicy,
} from "./impl/resolveDockerHostPolicy.js";
