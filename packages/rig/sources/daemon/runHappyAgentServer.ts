import { startHappyAgentDaemon } from "@slopus/happy-agent";

import { createGymInferenceFromEnvironment } from "./gymInference.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

/**
 * Runs the local daemon process: the complete Happy agent behind Rig's private Unix socket.
 *
 * Rig owns only the process lifecycle. Everything the daemon does — sessions, inference, tools,
 * persistence — belongs to `@slopus/happy-agent`.
 */
export async function runHappyAgentServer(): Promise<void> {
    const identity = getDaemonIdentity();
    const gymInference = createGymInferenceFromEnvironment();
    const daemon = await startHappyAgentDaemon({
        happyHome: getHappyDaemonPaths().happyHome,
        version: identity.version,
        ...(gymInference === undefined ? {} : { inference: gymInference }),
    });
    const stop = () => {
        void daemon.close().catch(() => undefined);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}
