import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Target path where the bundled documentation is mounted inside managed Docker containers. */
export const CONTAINER_DOCS_PATH = "/happy/docs";

/** Read-only documentation shipped inside Rig; this never points into a user's folders. */
export function getBundledDocsRoot(): string {
    const directory = dirname(fileURLToPath(import.meta.url));
    return basename(directory) === "dist"
        ? join(directory, "docs")
        : join(directory, "..", "..", "..", "..", "docs");
}
