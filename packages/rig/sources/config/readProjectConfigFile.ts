import { dirname, join } from "node:path";

import { readConfigFile } from "./readConfigFile.js";
import type { ConfigSource } from "./types.js";

export async function readProjectConfigFile(rigTomlPath: string): Promise<ConfigSource> {
    const preferred = await readConfigFile(rigTomlPath);
    if (preferred.exists) return preferred;
    return readConfigFile(join(dirname(rigTomlPath), "happy.toml"));
}
