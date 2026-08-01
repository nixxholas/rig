import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function createPrivateConfigurationDirectory(directory: string): Promise<void> {
    // Keep the user-facing Happy parent normally accessible and make only Config private.
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
}
