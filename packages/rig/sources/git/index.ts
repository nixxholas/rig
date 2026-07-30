export type { GitCommandRunner } from "./types.js";
export {
    GitStateTracker,
    entityKey,
    type GitChangeSnapshot,
    type GitStateTrackerOptions,
    type GitTrackedEntity,
} from "./GitStateTracker.js";
export { countUntrackedFileLines, type UntrackedFileCount } from "./countUntrackedFileLines.js";
export { createGitWorktree } from "./createGitWorktree.js";
export { isGitWorktreeAt } from "./isGitWorktreeAt.js";
export { markGitStateFromSessionEvent } from "./markGitStateFromSessionEvent.js";
export {
    parseGitRawNumstat,
    type GitDiffChange,
    type GitDiffChangeKind,
} from "./parseGitRawNumstat.js";
export { parseGitStatusV2, type GitStatusEntry, type GitStatusV2 } from "./parseGitStatusV2.js";
export { parseHostingRepository, type HostingRepository } from "./parseHostingRepository.js";
export { probeGitRepository, type GitRepositoryProbe } from "./probeGitRepository.js";
export { publishGitLiveEvent } from "./publishGitLiveEvent.js";
export { readGitCommonDir } from "./readGitCommonDir.js";
export { readGitTopLevel } from "./readGitTopLevel.js";
export { readGitWorktreeIdentity, type GitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
export { remoteProjectName } from "./remoteProjectName.js";
export { removeGitWorktree } from "./removeGitWorktree.js";
export {
    resolveGitComparisonBase,
    type GitBaseRunner,
    type GitComparisonBase,
} from "./resolveGitComparisonBase.js";
export { resolveGitCommit } from "./resolveGitCommit.js";
export { resolveGitExecutable, resetResolvedGitExecutable } from "./resolveGitExecutable.js";
export { resolveGitTrackedEntity } from "./resolveGitTrackedEntity.js";
export { runGitCommand } from "./runGitCommand.js";
export { runSandboxedGitCommand } from "./runSandboxedGitCommand.js";
export { runScanGit, type ScanGitResult } from "./runScanGit.js";
export { scanGitRepository, type ScanGitRepositoryOptions } from "./scanGitRepository.js";
export { selectGitRemoteUrl } from "./selectGitRemoteUrl.js";
export {
    gitWatchTargets,
    supportsRecursiveWorktreeWatch,
    watchGitRepositoryChanges,
    type GitRepositoryWatchOptions,
    type GitWatchTarget,
} from "./watchGitRepositoryChanges.js";
