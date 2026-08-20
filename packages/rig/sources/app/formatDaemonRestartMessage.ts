import type { DaemonRestartRequest } from "../client/index.js";

export function formatDaemonRestartMessage(request: DaemonRestartRequest): string {
    return `The running daemon uses Rig ${request.runningIdentity.version}, but this CLI is Rig ${request.currentIdentity.version}. Restart the daemon to use this CLI.`;
}
