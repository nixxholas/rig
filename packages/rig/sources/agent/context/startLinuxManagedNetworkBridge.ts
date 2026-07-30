import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { ManagedNetworkProxyHandle } from "./ManagedNetworkPolicy.js";

export interface LinuxManagedNetworkBridge {
    close(): Promise<void>;
    httpSocketPath: string;
    loopbackSockets: readonly { path: string; port: number }[];
    socksSocketPath: string;
}

export async function startLinuxManagedNetworkBridge(
    proxy: ManagedNetworkProxyHandle,
    options: { directory?: string; loopbackPorts?: readonly number[]; socatPath?: string } = {},
): Promise<LinuxManagedNetworkBridge> {
    const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "rig-network-")));
    const removeDirectory = options.directory === undefined;
    const httpSocketPath = join(directory, "http.sock");
    const socksSocketPath = join(directory, "socks.sock");
    const loopbackSockets = (options.loopbackPorts ?? []).map((port) => ({
        path: join(directory, `loopback-${String(port)}.sock`),
        port,
    }));
    const children: ChildProcess[] = [];
    try {
        children.push(
            startSocat(options.socatPath ?? "socat", httpSocketPath, proxy.port),
            startSocat(options.socatPath ?? "socat", socksSocketPath, proxy.socksPort),
            ...loopbackSockets.map(({ path, port }) =>
                startSocat(options.socatPath ?? "socat", path, port),
            ),
        );
        await Promise.all([
            waitForSocket(httpSocketPath, children[0]!),
            waitForSocket(socksSocketPath, children[1]!),
            ...loopbackSockets.map(({ path }, index) => waitForSocket(path, children[index + 2]!)),
        ]);
    } catch (error) {
        await stopChildren(children);
        if (removeDirectory) await rm(directory, { force: true, recursive: true });
        throw error;
    }
    let closed = false;
    return {
        httpSocketPath,
        loopbackSockets,
        socksSocketPath,
        async close() {
            if (closed) return;
            closed = true;
            await stopChildren(children);
            if (removeDirectory) await rm(directory, { force: true, recursive: true });
        },
    };
}

function startSocat(socatPath: string, socketPath: string, port: number): ChildProcess {
    return spawn(
        socatPath,
        [`UNIX-LISTEN:${socketPath},fork,reuseaddr,mode=0600`, `TCP:127.0.0.1:${String(port)}`],
        { stdio: ["ignore", "ignore", "pipe"] },
    );
}

async function waitForSocket(path: string, child: ChildProcess): Promise<void> {
    let stderr = "";
    let spawnError: Error | undefined;
    child.once("error", (error) => {
        spawnError = error;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (spawnError !== undefined) {
            throw new Error(
                `Could not start the Linux network bridge. Install socat and make sure it is available on PATH: ${spawnError.message}`,
            );
        }
        if (child.exitCode !== null) {
            throw new Error(
                `Could not start the Linux network bridge with socat.${stderr.trim() === "" ? "" : ` ${stderr.trim()}`}`,
            );
        }
        try {
            await access(path, constants.R_OK | constants.W_OK);
            return;
        } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    }
    throw new Error(`Timed out waiting for the Linux network bridge socket: ${path}`);
}

async function stopChildren(children: readonly ChildProcess[]): Promise<void> {
    await Promise.all(
        children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            child.kill("SIGTERM");
            await Promise.race([exited, delay(250)]);
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill("SIGKILL");
            await Promise.race([exited, delay(250)]);
        }),
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
}
