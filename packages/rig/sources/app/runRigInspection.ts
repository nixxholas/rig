import type { HealthResponse } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import { ensureLocalProtocolServer } from "../client/index.js";
import { readPackageVersion } from "../readPackageVersion.js";

export interface RigCliInspection {
    cliVersion: string;
    formatVersion: 2;
    health: HealthResponse;
    source: "cli";
}

export interface RunRigInspectionOptions {
    json?: boolean;
    log?: (line: string) => void;
    rigVersion?: string;
}

/** Reports only facts available through the public Happy Agent API. */
export async function runRigInspection(
    _ctx: Context,
    options: RunRigInspectionOptions = {},
): Promise<RigCliInspection> {
    const health = await (await ensureLocalProtocolServer()).client.getHealth();
    const inspection: RigCliInspection = {
        cliVersion: options.rigVersion ?? readPackageVersion(),
        formatVersion: 2,
        health,
        source: "cli",
    };
    const log = options.log ?? console.log;
    if (options.json === true) log(JSON.stringify(inspection));
    else for (const line of formatRigInspection(inspection)) log(line);
    return inspection;
}

export function formatRigInspection(inspection: RigCliInspection): readonly string[] {
    return [
        `Installed Rig CLI version: ${inspection.cliVersion}`,
        `Happy Agent daemon version: ${inspection.health.version.daemon}`,
        `Happy Agent protocol version: ${String(inspection.health.version.protocol)}`,
        inspection.health.ready ? "Happy Agent is ready." : "Happy Agent is starting.",
    ];
}

export function rigInspectionExitCode(_inspection: RigCliInspection): 0 {
    return 0;
}
