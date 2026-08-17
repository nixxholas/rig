import type { Context } from "@steve.kite/stdlib";

import { ensureLocalProtocolServer } from "../client/index.js";
import type { RigCliInstallationInspection } from "../protocol/index.js";
import { RIG_PROTOCOL_VERSION } from "../protocol/index.js";
import { readPackageVersion } from "../readPackageVersion.js";

export interface RunRigInspectionOptions {
    json?: boolean;
    log?: (line: string) => void;
    rigVersion?: string;
}

export async function runRigInspection(
    _ctx: Context,
    options: RunRigInspectionOptions = {},
): Promise<RigCliInstallationInspection> {
    const daemon = await (await ensureLocalProtocolServer()).client.installation();
    const inspection: RigCliInstallationInspection = {
        cliProtocolVersion: RIG_PROTOCOL_VERSION,
        cliVersion: options.rigVersion ?? readPackageVersion(),
        data: daemon.data,
        formatVersion: 1,
        source: "cli",
    };
    const log = options.log ?? console.log;
    if (options.json === true) log(JSON.stringify(inspection));
    else for (const line of formatRigInspection(inspection)) log(line);
    return inspection;
}

export function formatRigInspection(inspection: RigCliInstallationInspection): readonly string[] {
    const lines = [
        `Installed Rig CLI version: ${inspection.cliVersion}`,
        `Installed Rig CLI protocol version: ${String(inspection.cliProtocolVersion)}`,
    ];
    if (inspection.data.status === "initialized") {
        lines.push(
            "Happy Agent data is initialized.",
            `Happy Agent data epoch: ${inspection.data.epoch}`,
            `Happy Agent data schema version: ${String(inspection.data.schemaVersion)}`,
        );
    } else if (inspection.data.status === "absent") {
        lines.push("Happy Agent data has not been created.");
    } else if (inspection.data.status === "uninitialized") {
        lines.push("Happy Agent data exists but has not been initialized.");
    } else {
        lines.push(inspection.data.message);
    }
    return lines;
}

export function rigInspectionExitCode(inspection: RigCliInstallationInspection): 0 | 2 {
    return inspection.data.status === "incompatible" || inspection.data.status === "unavailable"
        ? 2
        : 0;
}