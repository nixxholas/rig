import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { HappyAgentClient } from "@slopus/happy-agent-client";

import { main } from "../../rig/sources/app/main.js";
import { createUnixSocketFetch, readTokenIfPresent } from "../../rig/sources/client/index.js";
import { getHappyDaemonPaths } from "../../rig/sources/daemon/index.js";
import { resolveGlobalDevelopmentIdentityVersion } from "../../rig/sources/development/resolveGlobalDevelopmentIdentityVersion.js";
import { installCliFailureReporting } from "../../rig/sources/installCliFailureReporting.js";
import { readPackageVersion } from "../../rig/sources/readPackageVersion.js";
import { reportCliFailure } from "../../rig/sources/reportCliFailure.js";

const execFileAsync = promisify(execFile);

installCliFailureReporting();
process.env.RIG_RUNTIME_MODE = "global-development";

void run().catch(reportCliFailure);

async function run(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === "--server") {
        const exitCode = await main(argv);
        if (exitCode !== undefined) process.exitCode = exitCode;
        return;
    }

    // Global development deliberately uses the user's normal Happy home and release identity.
    // Reloading first guarantees this checkout owns the daemon process; retaining the release
    // identity prevents another installed client (including Happy) from replacing it.
    delete process.env.HAPPY_HOME_DIR;
    delete process.env.RIG_DEVELOPMENT_BUILD_ID;
    process.env.RIG_DAEMON_IDENTITY_VERSION = await resolveGlobalDevelopmentIdentityVersion({
        currentSourceVersion: readPackageVersion(),
        readInstalledVersion,
        readRunningVersion,
    });
    await main(["daemon", "reload"]);

    const exitCode = await main(argv);
    if (exitCode !== undefined) process.exitCode = exitCode;
}

async function readRunningVersion(): Promise<string | undefined> {
    const paths = getHappyDaemonPaths();
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined) return undefined;
    try {
        const health = await new HappyAgentClient({
            endpoint: "http://happy",
            fetch: createUnixSocketFetch(paths.socketPath),
            token,
        }).getHealth();
        return health.version.daemon;
    } catch {
        return undefined;
    }
}

async function readInstalledVersion(): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync("rig", ["--version"], {
            encoding: "utf8",
            timeout: 5_000,
        });
        return /^Rig\s+(\S+)\s*$/u.exec(stdout)?.[1];
    } catch {
        return undefined;
    }
}
