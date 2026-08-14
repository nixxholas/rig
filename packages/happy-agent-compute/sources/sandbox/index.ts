/** The filesystem and network boundary a restricted command runs inside. */

export { assertCanReadPath } from "./assertCanReadPath.js";
export { assertCanWritePath } from "./assertCanWritePath.js";
export { createLinuxBubblewrapCommand } from "./createLinuxBubblewrapCommand.js";
export { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";
export { createSandboxFilesystemConfig } from "./createSandboxFilesystemConfig.js";
export { createSandboxedCommand, type SandboxedCommand } from "./createSandboxedCommand.js";
export {
    prepareProjectConfigPlaceholder,
    type ProjectConfigPlaceholder,
} from "./prepareProjectConfigPlaceholder.js";

export { createSandboxConfigDirectoryCache } from "./impl/createSandboxConfigDirectoryCache.js";
export { createSensitiveReadPaths } from "./impl/createSensitiveReadPaths.js";
export { createShellEnvironment } from "./impl/createShellEnvironment.js";
export { createToolEnvironment } from "./impl/createToolEnvironment.js";
export { findExecutableSearchPaths } from "./impl/findExecutableSearchPaths.js";
export { findGitWritablePaths } from "./impl/findGitWritablePaths.js";
export { isPathInsideWorkspace } from "./impl/isPathInsideWorkspace.js";
export { isProtectedGitControlPath } from "./impl/isProtectedGitControlPath.js";
export { isProtectedPath } from "./impl/isProtectedPath.js";
export { isProtectedProjectConfigPath } from "./impl/isProtectedProjectConfigPath.js";
export { MACOS_SEATBELT_BASE_POLICY } from "./impl/macOsSeatbeltBasePolicy.js";
export { materializeSandboxConfig } from "./impl/materializeSandboxConfig.js";
export { quoteShellArgument } from "./impl/quoteShellArgument.js";
export { resolveFileSystemPath } from "./impl/resolveFileSystemPath.js";
export { resolvePotentialPath } from "./impl/resolvePotentialPath.js";
export { runCleanupSteps } from "./impl/runCleanupSteps.js";
export { toComputeFileStat } from "./impl/toComputeFileStat.js";
