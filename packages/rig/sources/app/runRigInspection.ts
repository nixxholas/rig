import type { RigCliInstallationInspection } from "../protocol/index.js";
import { RIG_PROTOCOL_VERSION } from "../protocol/index.js";
import { queryRigInstallationData } from "../persistence/database/queryRigInstallationData.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { getEnvironmentLocalServerPaths } from "../server/index.js";

export interface RunRigInspectionOptions {
    databasePath?: string;
    json?: boolean;
    log?: (line: string) => void;
    rigVersion?: string;
}

export function runRigInspection(
    options: RunRigInspectionOptions = {},
): RigCliInstallationInspection {
    const inspection: RigCliInstallationInspection = {
        cliProtocolVersion: RIG_PROTOCOL_VERSION,
        cliVersion: options.rigVersion ?? readPackageVersion(),
        data: queryRigInstallationData(
            options.databasePath ?? getEnvironmentLocalServerPaths().databasePath,
        ),
        formatVersion: 1,
        source: "cli",
    };
    const log = options.log ?? console.log;
    if (options.json === true) {
        log(JSON.stringify(inspection));
        return inspection;
    }

    log(`Installed Rig CLI version: ${inspection.cliVersion}`);
    log(`Installed Rig CLI protocol version: ${String(inspection.cliProtocolVersion)}`);
    if (inspection.data.status === "absent") {
        log("Rig data has not been created.");
    } else if (inspection.data.status === "uninitialized") {
        log("Rig data exists but is not initialized for this Rig version.");
    } else if (inspection.data.status === "initialized") {
        log("Rig data is initialized.");
        log(`Rig data epoch: ${inspection.data.epoch}`);
        log(`Rig data schema version: ${String(inspection.data.schemaVersion)}`);
        if (inspection.data.schemaCompatibility === "upgrade_required") {
            log("Rig data requires an ordinary schema upgrade by this installed CLI.");
        }
    } else {
        log(inspection.data.message);
    }
    return inspection;
}
