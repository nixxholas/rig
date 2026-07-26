#!/usr/bin/env node

import { main } from "./app/main.js";
import { installCliFailureReporting } from "./installCliFailureReporting.js";
import { reportCliFailure } from "./reportCliFailure.js";

installCliFailureReporting();

main().then(() => {
    if (process.env.RIG_GYM_IN_PROCESS_DAEMON === "1") process.exit(0);
}, reportCliFailure);
