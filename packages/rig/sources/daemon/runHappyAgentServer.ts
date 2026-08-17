import { createRootContext } from "@steve.kite/stdlib";
import {
    startHappyAgentDaemon,
    type StartHappyAgentDaemonOptions,
} from "@slopus/happy-agent";

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
    const daemon = await startHappyAgentDaemon(createRootContext(), {
        happyHome: getHappyDaemonPaths().happyHome,
        httpConfiguration: { identity } as NonNullable<
            StartHappyAgentDaemonOptions["httpConfiguration"]
        > & { readonly identity: typeof identity },
        version: identity.version,
    });
    const stop = () => {
        void daemon.close().catch(() => undefined);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}
