import { homedir } from "node:os";
import { join } from "node:path";

import { getRigHome } from "../config/getRigHome.js";

/**
 * Rig's private root for the runtime state of running worklets.
 *
 * This is Rig's own bookkeeping, not the worklet's: it holds the sockets worklets are reached on
 * and their disposable private temporary folders, which is why it lives in Rig's managed home
 * rather than in the user-visible worklets folder. A worklet's `Data` folder stays exactly what
 * the worklet itself wrote there.
 */
export function getWorkletsRuntimeDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    return join(getRigHome(environment, homeDirectory), "worklets");
}

/** One worklet's own private runtime folder. */
export function getWorkletRuntimeDirectory(
    name: string,
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    return join(getWorkletsRuntimeDirectory(environment, homeDirectory), name);
}
