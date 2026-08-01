import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const socketRoot = fileURLToPath(new URL("../../../../.local/s/", import.meta.url));

/**
 * Creates a short-lived directory for Unix sockets inside the repository workspace.
 *
 * macOS sandboxes reject sockets in the operating-system temp directory, and macOS also limits
 * socket paths to roughly 104 bytes, so both the persistent root and generated prefix stay short.
 */
export async function createTestSocketDirectory(): Promise<string> {
    await mkdir(socketRoot, { recursive: true });
    return mkdtemp(join(socketRoot, "t-"));
}
