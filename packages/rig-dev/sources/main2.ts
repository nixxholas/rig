import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startHappyAgentDaemon } from "@slopus/happy-agent";
import { createRootContext } from "@steve.kite/stdlib";

import { parsePermissionMode } from "../../rig/sources/permissions/index.js";
import { configureDevelopmentEnvironment } from "../../rig/sources/development/index.js";
import { installCliFailureReporting } from "../../rig/sources/installCliFailureReporting.js";
import { reportCliFailure } from "../../rig/sources/reportCliFailure.js";
import { runApp, type RunAppOptions } from "../../rig/sources/app/runApp.js";

installCliFailureReporting();
process.env.RIG_RUNTIME_MODE = "local-development";

main().catch(reportCliFailure);

async function main(): Promise<void> {
    const invokedFrom = process.env.INIT_CWD?.trim();
    if (invokedFrom !== undefined && invokedFrom.length > 0) {
        process.chdir(invokedFrom);
    }

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    await configureDevelopmentEnvironment({ repositoryRoot });

    const ctx = createRootContext();
    const happyHome = happyAgentHome(repositoryRoot, process.env.RIG_DEV2_GLOBAL === "1");
    const daemon = await startHappyAgentDaemon(ctx, {
        happyHome,
        version: "development",
    });
    try {
        let options = runOptions(daemon.configuration.paths.agentHome);
        for (;;) {
            const result = await runApp(ctx.named("rig-tui"), options);
            if (result.action === "exit") break;
            const { sessionSelection: _, ...reloadOptions } = options;
            options = {
                ...reloadOptions,
                resumeSessionId: result.sessionId,
            };
        }
    } finally {
        await daemon.close(ctx.named("dev2-shutdown"));
    }
}

function happyAgentHome(repositoryRoot: string, global: boolean): string {
    const developmentRoot = join(resolve(repositoryRoot), ".rig-dev");
    return (
        process.env.HAPPY_HOME_DIR?.trim() ||
        (global ? join(homedir(), ".happy") : join(developmentRoot, ".happy"))
    );
}

function runOptions(agentHome: string): RunAppOptions {
    const options: RunAppOptions = {
        cwd: process.cwd(),
        happyAgentHome: agentHome,
    };
    if (process.env.RIG_EFFORT !== undefined) options.effort = process.env.RIG_EFFORT;
    if (process.env.RIG_MODEL !== undefined) options.modelId = process.env.RIG_MODEL;
    if (process.env.RIG_PROVIDER !== undefined) options.providerId = process.env.RIG_PROVIDER;
    if (process.env.RIG_PERMISSION_MODE !== undefined) {
        options.permissionMode = parsePermissionMode(process.env.RIG_PERMISSION_MODE);
    }
    return options;
}
