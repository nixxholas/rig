import { homedir } from "node:os";
import { join } from "node:path";

/** Private flat storage for chats that have not chosen a project, workspace, or folder yet. */
export function getUnsortedDirectory(homeDirectory: string = homedir()): string {
    return join(homeDirectory, "Happy", "Unsorted");
}
