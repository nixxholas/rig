import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
    type StartHappyAgentRuntimeOptions,
} from "@slopus/happy-agent-modules";

import { bindAgentSocket, type BoundAgentSocket } from "./socket/AgentSocket.js";

export type StartHappyAgentDaemonOptions = Omit<StartHappyAgentRuntimeOptions, "onPrepared">;

export interface HappyAgentDaemon {
    readonly socketPath: string;
    readonly tokenPath: string;
    close(): Promise<void>;
}

/** Start the modules-owned runtime and bind its API to the configured Unix socket. */
export async function startHappyAgentDaemon(
    options: StartHappyAgentDaemonOptions = {},
): Promise<HappyAgentDaemon> {
    let bound: BoundAgentSocket | undefined;
    let unsubscribeShutdown: (() => void) | undefined;
    let closeDaemon: (() => Promise<void>) | undefined;
    let shutdownRequested = false;
    let runtime: HappyAgentRuntime;

    try {
        runtime = await startHappyAgentRuntime({
            ...options,
            onPrepared: async (prepared) => {
                bound = await bindAgentSocket(prepared);
                unsubscribeShutdown = prepared.api.onShutdown(async () => {
                    if (closeDaemon === undefined) {
                        shutdownRequested = true;
                        return;
                    }
                    await closeDaemon();
                });
            },
        });
    } catch (error) {
        unsubscribeShutdown?.();
        await bound?.close().catch(() => undefined);
        throw error;
    }

    if (bound === undefined) {
        await runtime.close().catch(() => undefined);
        throw new Error("The Happy agent runtime started without binding its socket.");
    }

    let closing: Promise<void> | undefined;
    closeDaemon = () => {
        closing ??= closeHappyAgentDaemon(runtime, bound!, unsubscribeShutdown);
        return closing;
    };
    if (shutdownRequested) void closeDaemon();

    return {
        close: closeDaemon,
        socketPath: bound.socketPath,
        tokenPath: runtime.configuration.paths.tokenPath,
    };
}

async function closeHappyAgentDaemon(
    runtime: HappyAgentRuntime,
    bound: BoundAgentSocket,
    unsubscribeShutdown: (() => void) | undefined,
): Promise<void> {
    unsubscribeShutdown?.();
    const failures: unknown[] = [];
    await bound.close().catch((error: unknown) => failures.push(error));
    await runtime.close().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
        throw new AggregateError(failures, "The Happy agent daemon did not close cleanly.");
    }
}
