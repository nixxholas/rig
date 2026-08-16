import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";

import type { AgentDaemonPaths } from "./paths.js";

export interface StopAgentDaemonResult {
    /** Whether a running daemon was found and asked to stop. */
    readonly stopped: boolean;
    /** The process that owned the socket, when the daemon reported it. */
    readonly pid?: number;
}

/**
 * Ask the daemon listening on this agent home to shut down, and wait until its socket is gone.
 *
 * The daemon closes itself so it releases its store lock, flushes observation, and records why it
 * stopped; killing the process would leave all three half-finished.
 */
export async function stopAgentDaemon(
    paths: AgentDaemonPaths,
    options: { readonly timeoutMs?: number } = {},
): Promise<StopAgentDaemonResult> {
    const token = await readAgentToken(paths.tokenPath);
    if (token === undefined) return { stopped: false };
    const pid = await requestShutdown(paths.socketPath, token);
    if (pid === undefined) return { stopped: false };
    await waitForSocketToClose(paths.socketPath, options.timeoutMs ?? 15_000);
    return { pid, stopped: true };
}

async function readAgentToken(tokenPath: string): Promise<string | undefined> {
    try {
        const token = (await readFile(tokenPath, "utf8")).trim();
        return token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}

async function requestShutdown(socketPath: string, token: string): Promise<number | undefined> {
    return await new Promise<number | undefined>((resolveShutdown, reject) => {
        const call = request(
            {
                headers: { authorization: `Bearer ${token}` },
                method: "POST",
                path: "/v0/shutdown",
                socketPath,
            },
            (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                });
                response.on("end", () => {
                    if (response.statusCode !== 202) {
                        reject(
                            new Error(
                                `The Happy agent refused to stop (${String(response.statusCode)}).`,
                            ),
                        );
                        return;
                    }
                    resolveShutdown(readPid(body));
                });
            },
        );
        call.on("error", (error: NodeJS.ErrnoException) => {
            // Nothing is listening, so there is no daemon to stop.
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
                resolveShutdown(undefined);
                return;
            }
            reject(error);
        });
        call.end();
    });
}

function readPid(body: string): number | undefined {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const pid = (parsed as { pid?: unknown }).pid;
        return typeof pid === "number" && Number.isInteger(pid) ? pid : undefined;
    } catch {
        return undefined;
    }
}

async function waitForSocketToClose(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (!(await isListening(socketPath))) return;
        if (Date.now() >= deadline) {
            throw new Error(`The Happy agent did not release ${socketPath} in time.`);
        }
        await new Promise((wake) => setTimeout(wake, 100));
    }
}

async function isListening(socketPath: string): Promise<boolean> {
    return await new Promise<boolean>((resolveProbe) => {
        const socket = connect(socketPath);
        const finish = (result: boolean): void => {
            socket.destroy();
            resolveProbe(result);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
    });
}
