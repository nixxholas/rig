import { fileURLToPath } from "node:url";

import { main } from "../../rig/sources/app/main.js";
import { configureDevelopmentEnvironment } from "../../rig/sources/development/index.js";
import { installCliFailureReporting } from "../../rig/sources/installCliFailureReporting.js";
import { reportCliFailure } from "../../rig/sources/reportCliFailure.js";

// Development runs must fail the same way the published CLI does, not with a raw Node stack.
installCliFailureReporting();
process.env.RIG_RUNTIME_MODE = "local-development";

// pnpm runs package scripts from the package directory; start the session in
// the directory the developer actually invoked `pnpm dev` from.
const invokedFrom = process.env.INIT_CWD?.trim();
if (invokedFrom !== undefined && invokedFrom.length > 0) {
    process.chdir(invokedFrom);
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
await configureDevelopmentEnvironment({ repositoryRoot });

main().catch(reportCliFailure);
