import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const fixtureRoot = fileURLToPath(new URL("../../../../.local/f/", import.meta.url));

/**
 * Creates a directory for fixtures that a sandboxed command has to be able to read.
 *
 * The sandbox replaces `/tmp` with an empty tmpfs and binds back only the directory the command
 * runs in, so a fixture in the operating-system temp directory disappears the moment a command
 * reaches past that one directory. A Git worktree is exactly that case: its control directory lives
 * in the repository it was forked from, and on Linux the temp directory usually is `/tmp`. Fixtures
 * therefore live inside the repository workspace, which the sandbox can read.
 */
export async function createTestFixtureDirectory(): Promise<string> {
    await mkdir(fixtureRoot, { recursive: true });
    return mkdtemp(join(fixtureRoot, "t-"));
}
