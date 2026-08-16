import { connect } from "node:net";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { HappyAgentConfiguration } from "@slopus/happy-agent-modules";

export interface AgentDaemonPaths {
    readonly agentHome: string;
    readonly lockPath: string;
    readonly socketPath: string;
    readonly tokenPath: string;
}

export function resolveAgentDaemonPaths(configuration: HappyAgentConfiguration): AgentDaemonPaths {
    return {
        agentHome: configuration.paths.agentHome,
        lockPath: configuration.paths.agentLockPath,
        socketPath: configuration.paths.socketPath,
        tokenPath: configuration.paths.tokenPath,
    };
}

export async function prepareAgentSocket(paths: AgentDaemonPaths): Promise<void> {
    if (Buffer.byteLength(paths.socketPath) > 103) {
        throw new Error("The Happy agent socket path is too long for a Unix socket.");
    }
    await mkdir(dirname(paths.socketPath), { mode: 0o700, recursive: true });
    await removeStaleSocket(paths.socketPath, paths.lockPath);
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

async function removeStaleSocket(socketPath: string, lockPath: string): Promise<void> {
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
        throw new Error(await socketInUseMessage(socketPath, lockPath));
    }
    await unlink(socketPath);
}

// A daemon that is genuinely running is the common reason a new one cannot start, so the message
// names the process holding the socket instead of leaving the person to hunt for it.
async function socketInUseMessage(socketPath: string, lockPath: string): Promise<string> {
    const owner = await readLockOwnerPid(lockPath);
    if (owner === undefined) {
        return `Another Happy agent is already running on ${socketPath}. Stop it before starting a new one.`;
    }
    return `Another Happy agent is already running on ${socketPath} as process ${String(owner)}. Stop it before starting a new one.`;
}

const lockOwnerSchema = Type.Object(
    { pid: Type.Integer({ minimum: 1 }) },
    { additionalProperties: true },
);
type LockOwner = Static<typeof lockOwnerSchema>;

async function readLockOwnerPid(lockPath: string): Promise<number | undefined> {
    let contents: string;
    try {
        contents = await readFile(lockPath, "utf8");
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return undefined;
    }
    if (!Value.Check(lockOwnerSchema, parsed)) return undefined;
    const owner: LockOwner = parsed;
    return owner.pid;
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
