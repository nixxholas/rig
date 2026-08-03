import type { RigInstallationInspection } from "../protocol/index.js";
import { RIG_PROTOCOL_VERSION } from "../protocol/index.js";
import { inspectRigInstallationData } from "../persistence/database/inspectRigInstallationData.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { getEnvironmentLocalServerPaths } from "../server/index.js";

export interface RunRigInspectionOptions {
    databasePath?: string;
    json?: boolean;
    log?: (line: string) => void;
    rigVersion?: string;
}

export function runRigInspection(options: RunRigInspectionOptions = {}): RigInstallationInspection {
    const inspection: RigInstallationInspection = {
        data: inspectRigInstallationData(
            options.databasePath ?? getEnvironmentLocalServerPaths().databasePath,
        ),
        formatVersion: 1,
        protocolVersion: RIG_PROTOCOL_VERSION,
        rigVersion: options.rigVersion ?? readPackageVersion(),
    };
    const log = options.log ?? console.log;
    if (options.json === true) {
        log(JSON.stringify(inspection));
        return inspection;
    }

    log(`Rig version: ${inspection.rigVersion}`);
    log(`Rig protocol version: ${String(inspection.protocolVersion)}`);
    if (inspection.data.status === "absent") {
        log("Rig data has not been created.");
    } else if (inspection.data.status === "uninitialized") {
        log("Rig data exists but is not initialized for this Rig version.");
    } else {
        log("Rig data is initialized.");
        log(`Rig data epoch: ${inspection.data.epoch}`);
    }
    return inspection;
}
