import { HappyAgentClient, type HealthResponse } from "@slopus/happy-agent-client";

import {
    createUnixSocketFetch,
    ensureLocalProtocolServer,
    readTokenIfPresent,
    stopLocalProtocolServer,
} from "../client/index.js";
import { getHappyDaemonPaths } from "../daemon/index.js";

export type DaemonCommand = "reload" | "start" | "stop" | "status";

export async function runDaemonCommand(command: DaemonCommand): Promise<void> {
    if (command === "start") {
        const connection = await ensureLocalProtocolServer({
            confirmRestart: async () => true,
        });
        console.log(`Daemon is running at ${connection.paths.socketPath}`);
        console.log(`Daemon log: ${connection.paths.logPath}`);
        return;
    }

    const connection = await connectToExistingDaemon();
    if (command === "reload") {
        if (connection !== undefined) {
            await stopLocalProtocolServer(connection.client, getHappyDaemonPaths().socketPath);
        }
        const reloaded = await ensureLocalProtocolServer({
            confirmRestart: async () => true,
        });
        console.log(`Daemon is running at ${reloaded.paths.socketPath}`);
        console.log(`Daemon log: ${reloaded.paths.logPath}`);
        return;
    }

    if (command === "status") {
        const paths = getHappyDaemonPaths();
        if (connection === undefined) {
            console.log("Daemon is not running.");
            console.log(`Daemon log: ${paths.logPath}`);
            return;
        }
        if (!connection.health.ready) {
            console.log(`Daemon is starting at ${paths.socketPath}`);
            console.log(`Daemon log: ${paths.logPath}`);
            return;
        }
        console.log(`Daemon is running at ${paths.socketPath}`);
        console.log(`Daemon log: ${paths.logPath}`);
        return;
    }

    if (connection === undefined) {
        console.log("Daemon is not running.");
        return;
    }
    await connection.client.shutdown();
    console.log("Daemon is stopping.");
}

async function connectToExistingDaemon(): Promise<
    | {
          client: HappyAgentClient;
          health: HealthResponse;
      }
    | undefined
> {
    const paths = getHappyDaemonPaths();
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined) {
        return undefined;
    }

    const client = new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
    try {
        const health = await client.getHealth();
        return { client, health };
    } catch {
        return undefined;
    }
}
