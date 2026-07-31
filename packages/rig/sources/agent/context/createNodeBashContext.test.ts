import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeBashContext } from "./createNodeBashContext.js";
import { MAX_ACTIVE_BASH_SESSIONS } from "./bashSessionLimits.js";
import { createPermissionContext } from "../../permissions/index.js";
import {
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkProxyHandle,
} from "./ManagedNetworkPolicy.js";
import {
    type ManagedProcess,
    NativeProcessManager,
    type ProcessRunResult,
} from "../../processes/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("createNodeBashContext", () => {
    it("reports a proxy block as sandbox policy instead of an unexplained 403", async () => {
        const cwd = await makeTempDir();
        let blockedRequest: ManagedNetworkBlockedRequest | undefined;
        let block!: (request: ManagedNetworkBlockedRequest) => void;
        const proxy: ManagedNetworkProxyHandle = {
            blockedRequest: () => blockedRequest,
            close: async () => {},
            onBlockedRequest(listener) {
                block = (request) => {
                    blockedRequest = request;
                    listener(request);
                };
                return () => {};
            },
            port: 31_128,
            socksPort: 31_080,
        };
        const run = vi.fn(
            async (
                options: Parameters<NativeProcessManager["run"]>[0],
            ): Promise<ProcessRunResult> => {
                block({
                    host: "blocked.example",
                    port: 443,
                    protocol: "https_connect",
                    reason: "not_allowed",
                });
                expect(options.signal?.aborted).toBe(true);
                return {
                    aborted: true,
                    command: options.command,
                    cwd: options.cwd,
                    exitCode: null,
                    id: "network-denied",
                    killed: true,
                    pid: 1,
                    signal: "SIGTERM",
                    status: "killed",
                    stderr: "CONNECT tunnel failed, response 403\n",
                    stdout: "",
                    timedOut: false,
                };
            },
        );
        const context = createNodeBashContext({
            cwd,
            loadManagedNetworkPolicy: async () => ({
                allowedDomains: [{ domain: "allowed.example" }],
            }),
            permissions: createPermissionContext("workspace_write"),
            processManager: { run } as unknown as NativeProcessManager,
            startManagedNetwork: async () => ({
                close: async () => {},
                proxy,
            }),
        });

        await expect(context.run({ command: "curl https://blocked.example" })).resolves.toEqual({
            exitCode: 1,
            stderr: expect.stringContaining(
                "Network access to blocked.example:443 was denied by Rig's sandbox network policy",
            ),
            stdout: "",
            timedOut: false,
        });
        expect(run).toHaveBeenCalledOnce();
    });

    it("aborts a pending command when its permission mode changes before spawn", async () => {
        const cwd = await makeTempDir();
        const permissions = createPermissionContext("workspace_write");
        let releasePolicy!: () => void;
        const policyReleased = new Promise<void>((resolve) => {
            releasePolicy = resolve;
        });
        let markPolicyStarted!: () => void;
        const policyStarted = new Promise<void>((resolve) => {
            markPolicyStarted = resolve;
        });
        const run = vi.fn();
        const context = createNodeBashContext({
            cwd,
            loadManagedNetworkPolicy: async () => {
                markPolicyStarted();
                await policyReleased;
                return { allowLocalBinding: true };
            },
            permissions,
            processManager: { run } as unknown as NativeProcessManager,
        });

        const pending = context.run({ command: "printf should-not-run" });
        await policyStarted;
        permissions.setMode("read_only");
        releasePolicy();

        await expect(pending).rejects.toThrow(
            "Permission mode changed before the command could start.",
        );
        expect(run).not.toHaveBeenCalled();
    });

    it("finishes a background session even when managed network cleanup fails", async () => {
        const cwd = await makeTempDir();
        const result: ProcessRunResult = {
            aborted: false,
            command: "completed",
            cwd,
            exitCode: 0,
            id: "cleanup-failure",
            killed: false,
            pid: 1,
            signal: null,
            status: "exited",
            stderr: "",
            stdout: "done",
            timedOut: false,
        };
        const process = {
            interrupt: vi.fn(),
            kill: vi.fn(),
            readOutput: vi.fn(() => ({
                ...result,
                stderrDelta: "",
                stderrOffset: 0,
                stdoutDelta: "done",
                stdoutOffset: 4,
            })),
            wait: async () => result,
            writeStdin: vi.fn(),
        } as unknown as ManagedProcess;
        const context = createNodeBashContext({
            cwd,
            loadManagedNetworkPolicy: async () => ({
                allowedDomains: [{ domain: "example.com", ports: [443] }],
            }),
            permissions: createPermissionContext("workspace_write"),
            processManager: {
                start: vi.fn(() => process),
            } as unknown as NativeProcessManager,
            startManagedNetwork: async () => ({
                close: async () => {
                    throw new Error("proxy cleanup failed");
                },
            }),
        });

        const sessionId = await context.startSession({ command: "completed" });

        await expect(context.readSession(sessionId, { waitMs: 1_000 })).resolves.toMatchObject({
            exitCode: 1,
            status: "completed",
            stderr: expect.stringContaining("Command cleanup failed: proxy cleanup failed"),
            stderrDelta: expect.stringContaining("Command cleanup failed: proxy cleanup failed"),
        });
    });

    it.each(["read_only", "full_access"] as const)(
        "does not apply configured managed networking in %s mode",
        async (permissionMode) => {
            const cwd = await makeTempDir();
            const rigHome = join(cwd, "rig-home");
            await writeFile(
                join(cwd, "rig.toml"),
                '[network]\nallowed_domains = ["example.com"]\n',
            );
            vi.stubEnv("RIG_HOME", rigHome);
            vi.stubEnv("HTTP_PROXY", "http://ambient-proxy.example:8080");
            vi.stubEnv("NODE_USE_ENV_PROXY", "ambient");
            const run = vi.fn(
                async (
                    options: Parameters<NativeProcessManager["run"]>[0],
                ): Promise<ProcessRunResult> => ({
                    aborted: false,
                    command: options.command,
                    cwd: options.cwd,
                    exitCode: 0,
                    id: "network-mode-test",
                    killed: false,
                    pid: 1,
                    signal: null,
                    status: "exited",
                    stderr: "",
                    stdout: "",
                    timedOut: false,
                }),
            );
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext(permissionMode),
                processManager: { run } as unknown as NativeProcessManager,
            });

            await context.run({ command: "printf done" });

            expect(run).toHaveBeenCalledOnce();
            expect(run.mock.calls[0]?.[0].env?.HTTP_PROXY).toBe(
                "http://ambient-proxy.example:8080",
            );
            expect(run.mock.calls[0]?.[0].env?.NODE_USE_ENV_PROXY).toBe("ambient");
        },
    );

    it("evicts the oldest background command instead of refusing a new one", async () => {
        const cwd = await makeTempDir();
        const completion = new Promise<ProcessRunResult>(() => {});
        const process = {
            interrupt: vi.fn(),
            kill: vi.fn(),
            readOutput: vi.fn(() => ({
                aborted: false,
                command: "pending",
                cwd,
                exitCode: null,
                id: "pending",
                killed: false,
                pid: 1,
                signal: null,
                status: "running" as const,
                stderr: "",
                stderrDelta: "",
                stderrOffset: 0,
                stdout: "",
                stdoutDelta: "",
                stdoutOffset: 0,
                timedOut: false,
            })),
            wait: () => completion,
            writeStdin: vi.fn(),
        } as unknown as ManagedProcess;
        const start = vi.fn(() => process);
        const context = createNodeBashContext({
            cwd,
            permissions: createPermissionContext("full_access"),
            processManager: { start } as unknown as NativeProcessManager,
        });
        for (let index = 0; index < MAX_ACTIVE_BASH_SESSIONS; index += 1) {
            await context.startSession({ command: `pending-${String(index)}` });
        }

        // Running out of slots is ours to solve, not the model's: the oldest
        // command makes way and the new one starts.
        const evicting = await context.startSession({ command: "one-too-many" });

        expect(evicting).toBe(MAX_ACTIVE_BASH_SESSIONS + 1);
        expect(start).toHaveBeenCalledTimes(MAX_ACTIVE_BASH_SESSIONS + 1);
        expect(process.kill).toHaveBeenCalledWith("SIGTERM", { forceAfterMs: 500 });
        expect(await context.readSession(1)).toBeUndefined();
    });

    it.runIf(process.platform !== "win32")(
        "uses the system login shell for foreground and background commands",
        async () => {
            const cwd = await makeTempDir();
            const shell = join(cwd, "system-shell");
            await writeFile(
                shell,
                '#!/bin/sh\nif [ "$1" = "-lc" ]; then export RIG_LOGIN_SHELL_USED=1; fi\nshift\nexec /bin/sh -c "$1"\n',
            );
            await chmod(shell, 0o755);
            vi.stubEnv("SHELL", shell);
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext("full_access"),
                processManager: new NativeProcessManager(),
            });
            const command = '[ "$RIG_LOGIN_SHELL_USED" = 1 ] && printf LOGIN_SHELL_OK';

            await expect(context.run({ command })).resolves.toMatchObject({
                exitCode: 0,
                stdout: "LOGIN_SHELL_OK",
            });
            const sessionId = await context.startSession({ command });
            await expect(context.readSession(sessionId, { waitMs: 2_000 })).resolves.toMatchObject({
                exitCode: 0,
                status: "completed",
                stdout: "LOGIN_SHELL_OK",
            });
        },
    );

    it.runIf(process.platform !== "win32")(
        "leaves a long-running child alive after the command that started it exits",
        async () => {
            const cwd = await makeTempDir();
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext("full_access"),
                processManager: new NativeProcessManager(),
            });
            const marker = join(cwd, "server-was-alive.txt");

            // This is the dev-server shape: the shell starts something and
            // returns immediately. The child has to outlive its parent.
            await context.run({
                command: `nohup sh -c 'sleep 1; printf alive > ${marker}' >/dev/null 2>&1 &`,
                cwd,
            });
            await delay(2_500);

            await expect(readFile(marker, "utf8")).resolves.toBe("alive");
        },
        15_000,
    );

    it.runIf(process.platform !== "win32")(
        "keeps a background command running past its wait and reports it as still running",
        async () => {
            const cwd = await makeTempDir();
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext("full_access"),
                processManager: new NativeProcessManager(),
            });
            const marker = join(cwd, "finished-after-wait.txt");
            const sessionId = await context.startSession({
                command: `sleep 1; printf done > ${marker}`,
                cwd,
            });

            // The wait runs out well before the command does.
            await expect(context.readSession(sessionId, { waitMs: 100 })).resolves.toMatchObject({
                status: "running",
            });
            await delay(2_000);

            await expect(readFile(marker, "utf8")).resolves.toBe("done");
            await expect(context.readSession(sessionId)).resolves.toMatchObject({
                exitCode: 0,
                status: "completed",
            });
        },
        15_000,
    );

    it.runIf(process.platform !== "win32")(
        "reports each read only the output that arrived since the previous one",
        async () => {
            const cwd = await makeTempDir();
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext("full_access"),
                processManager: new NativeProcessManager(),
            });
            const sessionId = await context.startSession({
                command: "printf first; sleep 1; printf second",
                cwd,
            });

            const early = await context.readSession(sessionId, { waitMs: 300 });
            expect(early?.stdoutDelta).toBe("first");

            await delay(1_500);
            const later = await context.readSession(sessionId);

            expect(later?.stdoutDelta).toBe("second");
            expect(later?.stdout).toBe("firstsecond");
        },
        15_000,
    );

    it.runIf(process.platform !== "win32")(
        "lets an observer look at a background command without consuming the agent's output",
        async () => {
            const cwd = await makeTempDir();
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext("full_access"),
                processManager: new NativeProcessManager(),
            });
            const sessionId = await context.startSession({ command: "printf watched", cwd });
            await delay(1_000);

            // The terminal viewer polls the same session while the agent is
            // between reads; it must not eat what the agent has not seen.
            const peeked = await context.readSession(sessionId, { peek: true });
            expect(peeked?.stdoutDelta).toBe("watched");

            const agentRead = await context.readSession(sessionId);
            expect(agentRead?.stdoutDelta).toBe("watched");

            const afterAgentRead = await context.readSession(sessionId);
            expect(afterAgentRead?.stdoutDelta).toBe("");
        },
        15_000,
    );

    it.runIf(process.platform !== "win32")(
        "runs a command under a terminal when it asks for one",
        async () => {
            const cwd = await makeTempDir();
            const context = createNodeBashContext({
                cwd,
                permissions: createPermissionContext("full_access"),
                processManager: new NativeProcessManager(),
            });

            const withTerminal = await context.startSession({
                command: 'test -t 1 && printf HAS_TTY; printf %s "$TERM"',
                cwd,
                tty: true,
            });
            const withoutTerminal = await context.startSession({
                command: "test -t 1 && printf HAS_TTY; printf NO_TTY",
                cwd,
            });

            const terminal = await context.readSession(withTerminal, { waitMs: 5_000 });
            const pipes = await context.readSession(withoutTerminal, { waitMs: 5_000 });

            expect(terminal?.stdout).toContain("HAS_TTY");
            // Terminal-shaped output is discouraged, the way Codex does it.
            expect(terminal?.stdout).toContain("dumb");
            expect(pipes?.stdout).toContain("NO_TTY");
            expect(pipes?.stdout).not.toContain("HAS_TTY");
        },
        15_000,
    );

    it("observes background process completion only once across repeated polls", async () => {
        const cwd = await makeTempDir();
        let resolveCompletion!: (result: ProcessRunResult) => void;
        const completion = new Promise<ProcessRunResult>((resolve) => {
            resolveCompletion = resolve;
        });
        const completionThen = vi.spyOn(completion, "then");
        const result: ProcessRunResult = {
            aborted: false,
            command: "long-running",
            cwd,
            exitCode: 0,
            id: "process-1",
            killed: false,
            pid: 1,
            signal: null,
            status: "exited",
            stderr: "",
            stdout: "",
            timedOut: false,
        };
        const process = {
            async kill() {
                resolveCompletion(result);
            },
            readOutput(stdoutOffset: number, stderrOffset: number) {
                return {
                    ...result,
                    status: "running" as const,
                    stderrDelta: "",
                    stderrOffset,
                    stdoutDelta: "",
                    stdoutOffset,
                };
            },
            wait() {
                return completion;
            },
            writeStdin() {
                return false;
            },
        } as unknown as ManagedProcess;
        const processManager = {
            start() {
                return process;
            },
        } as unknown as NativeProcessManager;
        const context = createNodeBashContext({
            cwd,
            permissions: createPermissionContext("full_access"),
            processManager,
        });
        const sessionId = await context.startSession({ command: "long-running" });

        await context.readSession(sessionId, { waitMs: 1 });
        await context.readSession(sessionId, { waitMs: 1 });
        await context.readSession(sessionId, { waitMs: 1 });

        expect(completionThen).toHaveBeenCalledTimes(1);
        resolveCompletion(result);
        await completion;
    });

    it("continues returning background output after the retained buffer fills", async () => {
        const cwd = await makeTempDir();
        const processManager = new NativeProcessManager();
        const context = createNodeBashContext({
            cwd,
            permissions: createPermissionContext("full_access"),
            processManager,
        });
        const script = [
            'process.stdout.write("A".repeat(32) + "FIRST_MARKER\\n");',
            'process.stdin.once("data", () => {',
            '    process.stdout.write("SECOND_MARKER\\n");',
            "    process.exit(0);",
            "});",
        ].join(" ");
        const sessionId = await context.startSession({
            command: `${nodeBinary()} -e ${shellQuote(script)}`,
            maxOutputBytes: 16,
        });

        try {
            const first = await waitForSessionOutput(context, sessionId, "FIRST_MARKER");
            expect(first.stdout).toBe("AAAFIRST_MARKER\n");
            expect(first.stdoutDelta).toBe("AAAFIRST_MARKER\n");

            expect(context.supportsSessionInput).toBe(true);
            expect(await context.writeSession(sessionId, "continue\n")).toBe(true);
            const second = await waitForSessionOutput(context, sessionId, "SECOND_MARKER");
            expect(second.stdout).toBe("R\nSECOND_MARKER\n");
            expect(second.stdoutDelta).toBe("SECOND_MARKER\n");
        } finally {
            await context.killAllSessions?.();
        }
    });

    it("interrupts a running process without ending its shell session", async () => {
        const cwd = await makeTempDir();
        const processManager = new NativeProcessManager();
        const context = createNodeBashContext({
            cwd,
            permissions: createPermissionContext("full_access"),
            processManager,
        });
        const script = [
            'process.stdin.setEncoding("utf8");',
            'process.on("SIGINT", () => process.stdout.write("INTERRUPTED\\n"));',
            'process.stdin.on("data", (data) => {',
            "    process.stdout.write(`RECEIVED:${data.trim()}\\n`);",
            "    process.exit(0);",
            "});",
            'process.stdout.write("READY\\n");',
            "setInterval(() => {}, 1_000);",
        ].join(" ");
        const sessionId = await context.startSession({
            command: `${nodeBinary()} -e ${shellQuote(script)}`,
        });

        try {
            await waitForSessionOutput(context, sessionId, "READY");
            await expect(context.interruptSession?.(sessionId)).resolves.toBe(true);
            const interrupted = await waitForSessionOutput(context, sessionId, "INTERRUPTED");
            expect(interrupted.status).toBe("running");

            await expect(context.writeSession(sessionId, "continue\n")).resolves.toBe(true);
            const completed = await waitForSessionOutput(
                context,
                sessionId,
                "RECEIVED:continue",
                "completed",
            );
            expect(completed.status).toBe("completed");
        } finally {
            await context.killAllSessions?.();
        }
    });
});

async function waitForSessionOutput(
    context: ReturnType<typeof createNodeBashContext>,
    sessionId: number,
    marker: string,
    status?: "completed" | "running",
) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const snapshot = await context.readSession(sessionId, { waitMs: 20 });
        if (
            snapshot?.stdout.includes(marker) &&
            (status === undefined || snapshot.status === status)
        ) {
            return snapshot;
        }
    }
    throw new Error(`Timed out waiting for ${marker}.`);
}

async function makeTempDir(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "rig-node-bash-"));
    tempDirs.push(path);
    return path;
}

function nodeBinary(): string {
    return shellQuote(process.execPath);
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
