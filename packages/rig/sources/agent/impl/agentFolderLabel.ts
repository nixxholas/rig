import { basename } from "node:path";

/** Human context for peer messages that does not depend on one container's mount path. */
export function agentFolderLabel(path: string): string {
    return basename(path) || path;
}
