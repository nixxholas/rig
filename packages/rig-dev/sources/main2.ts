import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadHappyAgentConfiguration,
    resolveAgentDaemonPaths,
    startHappyAgentDaemon,
    stopAgentDaemon,
} from "@slopus/happy-agent";
import { createRootContext } from "@steve.kite/stdlib";

import { parsePermissionMode } from "../../rig/sources/app/parsePermissionMode.js";
import { configureDevelopmentEnvironment } from "../../rig/sources/development/index.js";
import { getDaemonIdentity } from "../../rig/sources/daemon/index.js";
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

    // A developer-set Happy home wins over both the development default and the global opt-in.
    const configuredHome = process.env.HAPPY_HOME_DIR?.trim();
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    await configureDevelopmentEnvironment({ repositoryRoot });

    const ctx = createRootContext();
    const happyHome = happyAgentHome(
        repositoryRoot,
        process.env.RIG_DEV2_GLOBAL === "1",
        configuredHome,
    );
    // The in-process daemon and the TUI's own connection logic must agree on the Happy home and
    // the daemon identity, or runApp would try to replace the daemon this process just started.
    process.env.HAPPY_HOME_DIR = happyHome;
    if (isDaemonStop(process.argv.slice(2))) {
        await stopDaemon(happyHome);
        return;
    }
    const identity = getDaemonIdentity();
    const daemon = await startHappyAgentDaemon({
        happyHome,
        httpConfiguration: { identity },
        version: identity.version,
    });
    try {
        let options = runOptions();
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
        await daemon.close();
    }
}

function isDaemonStop(args: readonly string[]): boolean {
    return args[0] === "daemon" && args[1] === "stop";
}

async function stopDaemon(happyHome: string): Promise<void> {
    const configuration = await loadHappyAgentConfiguration(happyHome);
    const paths = resolveAgentDaemonPaths(configuration);
    const result = await stopAgentDaemon(paths);
    if (!result.stopped) {
        process.stdout.write("No Happy agent is running for this development home.\n");
        return;
    }
    const owner = result.pid === undefined ? "" : ` (process ${String(result.pid)})`;
    process.stdout.write(`Stopped the Happy agent${owner}.\n`);
}

function happyAgentHome(
    repositoryRoot: string,
    global: boolean,
    configuredHome: string | undefined,
): string {
    if (configuredHome !== undefined && configuredHome.length > 0) return configuredHome;
    if (global) return join(homedir(), ".happy");
    return join(resolve(repositoryRoot), ".rig-dev", ".happy");
}

function runOptions(): RunAppOptions {
    const options: RunAppOptions = {
        cwd: process.cwd(),
    };
    if (process.env.RIG_EFFORT !== undefined) options.effort = process.env.RIG_EFFORT;
    if (process.env.RIG_MODEL !== undefined) options.modelId = process.env.RIG_MODEL;
    if (process.env.RIG_PROVIDER !== undefined) options.providerId = process.env.RIG_PROVIDER;
    if (process.env.RIG_PERMISSION_MODE !== undefined) {
        options.permissionMode = parsePermissionMode(process.env.RIG_PERMISSION_MODE);
    }
    return options;
}
