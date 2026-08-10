import { main } from "../../rig/sources/app/main.js";
import { installCliFailureReporting } from "../../rig/sources/installCliFailureReporting.js";
import { reportCliFailure } from "../../rig/sources/reportCliFailure.js";

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

    // Global development deliberately uses the user's normal database, socket, and release
    // identity. Reloading first guarantees this checkout owns the daemon process; retaining the
    // release identity prevents another installed client (including Happy) from replacing it.
    delete process.env.RIG_SERVER_DIRECTORY;
    delete process.env.RIG_SERVER_SOCKET_PATH;
    delete process.env.RIG_SERVER_TOKEN_PATH;
    delete process.env.RIG_DEVELOPMENT_BUILD_ID;
    await main(["daemon", "reload"]);

    const exitCode = await main(argv);
    if (exitCode !== undefined) process.exitCode = exitCode;
}
