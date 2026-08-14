import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import type { ComputeShell } from "../../sources/ComputeShell.js";
import { createHostCompute } from "../../sources/host/index.js";
import { createHostShell } from "../../sources/host/createHostShell.js";
import {
    NativeProcessManager,
    type ProcessRunOptions,
    type ProcessRunResult,
} from "../../sources/processes/index.js";

const ctx: Context = createRootContext().named("host-shell-test");
const computes: Compute[] = [];
const shells: ComputeShell[] = [];
const temporaryDirectories: string[] = [];
const fullAccessPermissions = computePermissions("full_access");

afterEach(async () => {
    await Promise.all(computes.splice(0).map((compute) => compute.dispose(ctx)));
    await Promise.all(shells.splice(0).map((shell) => shell.killAllSessions?.()));
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("createHostShell commands", () => {
    it("runs a command to completion in the working directory", async () => {
        const { compute } = await fullAccessCompute();

        await expect(
            compute.shell.run({ command: "printf hello", permissions: fullAccessPermissions }),
        ).resolves.toMatchObject({
            stdout: "hello",
            stderr: "",
            exitCode: 0,
            timedOut: false,
        });
    });

    it("backgrounds a session that reaches its timeout instead of killing it", async () => {
        const { compute } = await fullAccessCompute();
        const sessionId = await compute.shell.startSession({
            command: "sleep 0.2; printf survived",
            permissions: fullAccessPermissions,
            timeoutMs: 0,
        });

        // The timeout marks the session, but the command keeps running to completion.
        await vi.waitFor(async () => {
            const peeked = await compute.shell.readSession(sessionId, { peek: true });
            expect(peeked?.timedOut).toBe(true);
        });
        await vi.waitFor(async () => {
            const snapshot = await compute.shell.readSession(sessionId, { peek: true });
            expect(snapshot).toMatchObject({ status: "completed", stdout: "survived" });
        });
    });

    it("returns only the output that arrived since the previous read", async () => {
        const { compute } = await fullAccessCompute();
        const sessionId = await compute.shell.startSession({
            command: "printf a; sleep 0.2; printf b",
            permissions: fullAccessPermissions,
        });

        let firstDelta = "";
        await vi.waitFor(async () => {
            const read = await compute.shell.readSession(sessionId, { waitMs: 20 });
            firstDelta += read?.stdoutDelta ?? "";
            expect(firstDelta).toBe("a");
            expect(read?.status).toBe("running");
        });

        let completed;
        await vi.waitFor(async () => {
            completed = await compute.shell.readSession(sessionId, { waitMs: 30 });
            expect(completed?.status).toBe("completed");
        });
        expect(completed).toMatchObject({ stdoutDelta: "b" });
    });

    it("sends characters to a running command's input", async () => {
        const { compute } = await fullAccessCompute();
        const sessionId = await compute.shell.startSession({
            command: "cat",
            permissions: fullAccessPermissions,
        });

        expect(compute.shell.supportsSessionInput).toBe(true);
        await expect(
            compute.shell.writeSession(fullAccessPermissions, sessionId, "hello\n"),
        ).resolves.toBe(true);

        await vi.waitFor(async () => {
            const read = await compute.shell.readSession(sessionId, { peek: true });
            expect(read?.stdout).toContain("hello");
        });

        await compute.shell.killSession(sessionId);
    });

    it("stops the whole process tree when a session is killed", async () => {
        const { compute, cwd } = await fullAccessCompute();
        const marker = join(cwd, "descendant-marker.txt");
        const writer = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 500);`;
        const sessionId = await compute.shell.startSession({
            command: `${shellQuote(process.execPath)} -e ${shellQuote(writer)} & ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => undefined, 1000);")}`,
            permissions: fullAccessPermissions,
        });
        await vi.waitFor(() => expect(compute.shell.activeSessionCount?.()).toBe(1));

        await expect(compute.shell.killSession(sessionId)).resolves.toMatchObject({
            sessionId,
            status: "killed",
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(compute.shell.activeSessionCount?.()).toBe(0);
    });

    it("reports a background exit that no read observed", async () => {
        const { compute } = await fullAccessCompute();
        const exits: unknown[] = [];
        compute.shell.setSessionExitListener?.((exit) => {
            exits.push(exit);
        });

        await compute.shell.startSession({
            command: "printf finished",
            permissions: fullAccessPermissions,
        });

        await vi.waitFor(() =>
            expect(exits).toEqual([
                {
                    command: "printf finished",
                    exitCode: 0,
                    sessionId: 1,
                    status: "completed",
                },
            ]),
        );
    });

    it("evicts and kills the oldest session when the cap is reached", async () => {
        const cwd = await makeWorkspace();
        const processManager = new NativeProcessManager(ctx);
        const shell = createHostShell({
            ctx,
            cwd,
            processManager,
            maxActiveSessions: 2,
        });
        shells.push(shell);

        const first = await shell.startSession({
            command: "sleep 100",
            permissions: fullAccessPermissions,
        });
        await shell.startSession({ command: "sleep 100", permissions: fullAccessPermissions });
        await vi.waitFor(() => expect(shell.activeSessionCount?.()).toBe(2));

        await shell.startSession({ command: "sleep 100", permissions: fullAccessPermissions });

        await vi.waitFor(async () => {
            const evicted = await shell.readSession(first, { peek: true });
            expect(evicted?.status).toBe("killed");
        });
        expect(shell.activeSessionCount?.()).toBe(2);
    });

    it("keeps the permission value a command started with when the caller replaces its policy", async () => {
        const { compute, cwd } = await fullAccessCompute();
        const outside = join(cwd, "..", "captured-permission.txt");
        temporaryDirectories.push(outside);
        let callerPermissions = fullAccessPermissions;

        const pending = compute.shell.run({
            command: `sleep 0.05; printf captured > ${shellQuote(outside)}`,
            permissions: callerPermissions,
        });
        callerPermissions = computePermissions("read_only");

        await expect(pending).resolves.toMatchObject({ exitCode: 0 });
        await expect(access(outside)).resolves.toBeUndefined();
        expect(callerPermissions.mode).toBe("read_only");
    });

    it("maps an allowed-host egress grant to a command-scoped managed network policy", async () => {
        const cwd = await makeWorkspace();
        const run = vi.fn(async (_ctx: Context, options: ProcessRunOptions) =>
            completedProcessResult(options),
        );
        const startManagedNetwork = vi.fn(async () => undefined);
        const shell = createHostShell({
            ctx,
            cwd,
            processManager: { run } as unknown as NativeProcessManager,
            startManagedNetwork,
        });
        shells.push(shell);
        const permissions = computePermissions("workspace_write", {
            network: {
                egress: true,
                allowedHosts: ["api.example.com", "*.packages.example.com"],
                localBinding: false,
            },
        });

        await shell.run({ command: "true", permissions });

        expect(startManagedNetwork).toHaveBeenCalledWith({
            allowedDomains: [{ domain: "api.example.com" }, { domain: "*.packages.example.com" }],
        });
        expect(run).toHaveBeenCalledOnce();
    });

    it("gives Workspace write unrestricted egress when the operation explicitly requests it", async () => {
        const cwd = await makeWorkspace();
        const run = vi.fn(async (_ctx: Context, options: ProcessRunOptions) =>
            completedProcessResult(options),
        );
        const startManagedNetwork = vi.fn(async () => undefined);
        const shell = createHostShell({
            ctx,
            cwd,
            processManager: { run } as unknown as NativeProcessManager,
            startManagedNetwork,
        });
        shells.push(shell);
        const permissions = computePermissions("workspace_write", {
            network: { egress: true, localBinding: false },
        });

        await shell.run({ command: "true", permissions });

        const processOptions = run.mock.calls[0]?.[1];
        if (process.platform === "linux") {
            expect(startManagedNetwork).toHaveBeenCalledWith({
                allowedDomains: [{ domain: "*" }],
            });
            expect(processOptions?.args).toContain("--unshare-net");
        } else if (process.platform === "darwin") {
            expect(startManagedNetwork).toHaveBeenCalledWith(undefined);
            expect(processOptions?.args?.[1]).toContain(
                '(allow network-outbound (remote ip "*:*"))',
            );
        }
    });

    it("keeps granted egress from also granting local binding when binding is refused", async () => {
        const cwd = await makeWorkspace();
        await mkdir(join(cwd, ".agent-state"));
        const run = vi.fn(async (_ctx: Context, options: ProcessRunOptions) =>
            completedProcessResult(options),
        );
        const shell = createHostShell({
            ctx,
            cwd,
            processManager: { run } as unknown as NativeProcessManager,
            startManagedNetwork: async () => undefined,
        });
        shells.push(shell);
        const permissions = computePermissions("auto", {
            network: { egress: true, localBinding: false },
        });

        await shell.run({ command: "true", permissions });

        const processOptions = run.mock.calls[0]?.[1];
        expect(processOptions?.command).not.toBe("true");
        if (process.platform === "linux") {
            expect(processOptions?.args).toContain("--unshare-net");
            expect(processOptions?.args).not.toContain(join(cwd, ".agent-state"));
        } else if (process.platform === "darwin") {
            expect(processOptions?.args?.[1]).toContain(
                '(allow network-outbound (remote ip "*:*"))',
            );
            expect(processOptions?.args?.[1]).not.toContain(
                '(allow network-bind (local ip "*:*"))',
            );
            expect(processOptions?.args).not.toEqual(
                expect.arrayContaining([expect.stringContaining(join(cwd, ".agent-state"))]),
            );
        }
    });

    it("kills its active sessions when the compute is disposed", async () => {
        const { compute } = await fullAccessCompute();
        const sessionId = await compute.shell.startSession({
            command: "sleep 100",
            permissions: fullAccessPermissions,
        });
        await vi.waitFor(() => expect(compute.shell.activeSessionCount?.()).toBe(1));

        await compute.dispose(ctx);
        computes.length = 0;

        await expect(compute.shell.readSession(sessionId)).resolves.toMatchObject({
            status: "killed",
        });
        expect(compute.shell.activeSessionCount?.()).toBe(0);
    });
});

async function fullAccessCompute(): Promise<{ compute: Compute; cwd: string }> {
    const cwd = await makeWorkspace();
    const compute = createHostCompute({
        ctx,
        cwd,
    });
    computes.push(compute);
    return { compute, cwd };
}

async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "host-shell-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    return cwd;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function completedProcessResult(options: ProcessRunOptions): ProcessRunResult {
    return {
        aborted: false,
        command: options.command,
        cwd: options.cwd,
        exitCode: 0,
        id: "test-process",
        killed: false,
        pid: 1,
        signal: null,
        status: "exited",
        stderr: "",
        stdout: "",
        timedOut: false,
    };
}
