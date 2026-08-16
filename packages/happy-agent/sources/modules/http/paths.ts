import { connect } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { HappyAgentConfiguration } from "@slopus/happy-agent-modules";

export interface AgentDaemonPaths {
    readonly agentHome: string;
    readonly socketPath: string;
    readonly tokenPath: string;
}

export function resolveAgentDaemonPaths(configuration: HappyAgentConfiguration): AgentDaemonPaths {
    return {
        agentHome: configuration.paths.agentHome,
        socketPath: configuration.paths.socketPath,
        tokenPath: configuration.paths.tokenPath,
    };
}

export async function prepareAgentSocket(paths: AgentDaemonPaths): Promise<void> {
    if (Buffer.byteLength(paths.socketPath) > 103) {
        throw new Error("The Happy agent socket path is too long for a Unix socket.");
    }
    await mkdir(dirname(paths.socketPath), { mode: 0o700, recursive: true });
    await removeStaleSocket(paths.socketPath);
}

export async function secureAgentSocket(socketPath: string): Promise<void> {
    await chmod(socketPath, 0o600);
}

export async function removeOwnedAgentSocket(socketPath: string): Promise<void> {
    try {
        const stat = await lstat(socketPath);
        if (!stat.isSocket()) return;
        if (
            typeof stat.uid === "number" &&
            process.getuid !== undefined &&
            stat.uid !== process.getuid()
        ) {
            return;
        }
        await unlink(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
    let stat;
    try {
        stat = await lstat(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    if (!stat.isSocket()) {
        throw new Error(`Refusing to remove non-socket path: ${socketPath}`);
    }
    if (
        typeof stat.uid === "number" &&
        process.getuid !== undefined &&
        stat.uid !== process.getuid()
    ) {
        throw new Error(`Refusing to remove socket owned by another user: ${socketPath}`);
    }

    const active = await probeSocket(socketPath);
    if (active) {
        throw new Error(`The Happy agent socket is already in use: ${socketPath}`);
    }
    await unlink(socketPath);
}

async function probeSocket(socketPath: string): Promise<boolean> {
    return await new Promise<boolean>((resolveProbe, reject) => {
        const socket = connect(socketPath);
        let settled = false;
        const finish = (result: boolean, error?: unknown): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error === undefined) resolveProbe(result);
            else reject(error);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
                finish(false);
                return;
            }
            finish(false, error);
        });
    });
}
