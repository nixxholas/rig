import { arch, platform, release } from "node:os";

import type { DockerExecutionConfig } from "../execution/index.js";

export function formatSessionTransferNotice(input: {
    commit: string;
    docker?: DockerExecutionConfig;
    workspacePath: string;
}): string {
    const compute =
        input.docker === undefined
            ? `local ${platform()} ${release()} (${arch()})`
            : `Docker image ${input.docker.image} (${input.docker.workingDirectory})`;
    return [
        "<session-transfer-notice>",
        `This session moved to workspace ${input.workspacePath}.`,
        `Compute: ${compute}.`,
        "",
        "Transferred:",
        "- This session's durable conversation and state, with the same session and agent identities.",
        `- Git commit ${input.commit}, including every file committed there, plus regular files and symlinks from the source working-tree overlay on top of it.`,
        "- Tracked working-tree deletions, even when the deleted path matches the root .happyignore file.",
        "- Git-ignored overlay files unless the root .happyignore file excludes them.",
        "- The .context folder, always, even when .happyignore would otherwise exclude it.",
        "",
        "Not transferred:",
        "- Anything outside that session, Git payload, and .context.",
        "- Unix sockets, FIFOs, and other non-regular working-tree entries.",
        "- Running processes and runtime state. Dependency and cache files move only as working-tree overlay files when .happyignore does not exclude them.",
        "- Subagents spawned earlier remain in the previous workspace.",
        "</session-transfer-notice>",
    ].join("\n");
}
