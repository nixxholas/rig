import { readPackageVersion } from "../readPackageVersion.js";
import type { DaemonIdentity } from "../protocol/index.js";

export function getDaemonIdentity(version: string = readPackageVersion()): DaemonIdentity {
    return { version };
}
