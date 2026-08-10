import type { RigCliInstallationInspection } from "../protocol/index.js";
import { RIG_PROTOCOL_VERSION } from "../protocol/index.js";
import { queryRigInstallationData } from "../persistence/database/queryRigInstallationData.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { getEnvironmentLocalServerPaths } from "../server/index.js";
import type { Context } from "@steve.kite/stdlib";

export interface RunRigInspectionOptions {
    databasePath?: string;
    json?: boolean;
    log?: (line: string) => void;
    rigVersion?: string;
}

export async function runRigInspection(
    ctx: Context,
    options: RunRigInspectionOptions = {},
): Promise<RigCliInstallationInspection> {
    const inspection: RigCliInstallationInspection = {
        cliProtocolVersion: RIG_PROTOCOL_VERSION,
        cliVersion: options.rigVersion ?? readPackageVersion(),
        data: await queryRigInstallationData(
            ctx,
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

    for (const line of formatRigInspection(inspection)) log(line);
    return inspection;
}

export function formatRigInspection(inspection: RigCliInstallationInspection): readonly string[] {
    const lines = [
        `Installed Rig CLI version: ${inspection.cliVersion}`,
        `Installed Rig CLI protocol version: ${String(inspection.cliProtocolVersion)}`,
    ];
    if (inspection.data.status === "absent") {
        lines.push("Rig data has not been created.");
    } else if (inspection.data.status === "uninitialized") {
        lines.push("Rig data exists but has not been initialized.");
    } else if (inspection.data.status === "upgrade_required") {
        lines.push(
            inspection.data.message,
            `Rig data schema version: ${String(inspection.data.schemaVersion)}`,
        );
    } else if (inspection.data.status === "initialized") {
        lines.push(
            "Rig data is initialized.",
            `Rig data epoch: ${inspection.data.epoch}`,
            `Rig data schema version: ${String(inspection.data.schemaVersion)}`,
        );
        if (inspection.data.schemaCompatibility === "upgrade_required") {
            lines.push("Rig data requires an ordinary schema upgrade by this installed CLI.");
        }
    } else {
        lines.push(inspection.data.message);
    }
    return lines;
}

/** Exit 2 tells launchers the inspection succeeded but the installation cannot be used safely. */
export function rigInspectionExitCode(inspection: RigCliInstallationInspection): 0 | 2 {
    return inspection.data.status === "incompatible" || inspection.data.status === "unavailable"
        ? 2
        : 0;
}
