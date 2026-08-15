import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { NativeProcessManager } from "../../sources/processes/index.js";

const ctx: Context = createRootContext().named("native-process-manager-test");
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("NativeProcessManager", () => {
    it("runs a command with an explicit cwd and captures stdout and stderr", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);

        const result = await manager.run(ctx, {
            command: "printf 'hello'; printf 'warn' >&2",
            cwd,
            timeoutMs: 2_000,
            maxOutputBytes: 4_096,
        });

        expect(result.stdout).toBe("hello");
        expect(result.stderr).toBe("warn");
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(manager.activeCount()).toBe(0);
    });

    it("passes direct process arguments without host-shell parsing", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const value = `quoted & piped | redirected > untouched`;

        const result = await manager.run(ctx, {
            args: ["-e", "process.stdout.write(process.argv[1])", value],
            command: process.execPath,
            cwd,
            timeoutMs: 2_000,
        });

        expect(result.stdout).toBe(value);
        expect(result.exitCode).toBe(0);
    });

    it("keeps trusted descriptor input separate from workload stdin", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const script = [
            'const fs = require("node:fs");',
            'const policy = fs.readFileSync(3, "utf8");',
            'process.stdin.setEncoding("utf8");',
            'process.stdin.once("data", data => {',
            "  process.stdout.write(`policy:${policy};stdin:${data.trim()}`);",
            "  process.exit(0);",
            "});",
        ].join("");

        const managedProcess = await manager.start(ctx, {
            args: ["-e", script],
            command: process.execPath,
            cwd,
            extraFileDescriptorInputs: ['{"mode":"workspace_write"}'],
        });

        await expect(managedProcess.writeStdin(ctx, "workload-input\n")).resolves.toBe(true);
        await expect(managedProcess.wait(ctx)).resolves.toMatchObject({
            exitCode: 0,
            stdout: 'policy:{"mode":"workspace_write"};stdin:workload-input',
        });
    });

    it.skipIf(process.platform === "win32")(
        "kills a spawned process when trusted descriptor initialization fails",
        async () => {
            const cwd = await makeTemporaryDirectory();
            const marker = join(cwd, "startup-process.pid");
            const manager = new NativeProcessManager(ctx);
            const script = [
                'const fs = require("node:fs");',
                `fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
                "fs.closeSync(3);",
                "setInterval(() => undefined, 1000);",
            ].join("");
            let pid: number | undefined;

            try {
                await expect(
                    manager.start(ctx, {
                        args: ["-e", script],
                        command: process.execPath,
                        cwd,
                        extraFileDescriptorInputs: ["x".repeat(16 * 1_024 * 1_024)],
                    }),
                ).rejects.toThrow();
                pid = Number(await readFile(marker, "utf8"));

                await waitForProcessExit(pid);
                expect(manager.activeCount()).toBe(0);
            } finally {
                if (pid !== undefined && isProcessAlive(pid)) {
                    try {
                        process.kill(-pid, "SIGKILL");
                    } catch {
                        process.kill(pid, "SIGKILL");
                    }
                }
            }
        },
    );

    it("keeps started processes tracked and writes stdin to them", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const script =
            "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { process.stdout.write(`seen:${data.trim()}`); process.exit(0); });";

        const managedProcess = await manager.start(ctx, {
            command: `${nodeBinary()} -e ${shellQuote(script)}`,
            cwd,
            maxOutputBytes: 4_096,
        });

        expect(manager.activeCount()).toBe(1);
        await expect(managedProcess.writeStdin(ctx, "input\n")).resolves.toBe(true);

        const result = await managedProcess.wait(ctx);
        expect(result.stdout).toBe("seen:input");
        expect(result.exitCode).toBe(0);
        expect(manager.activeCount()).toBe(0);
    });

    it("writes startup stdin before later session input", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const script =
            "process.stdin.setEncoding('utf8'); let data = ''; process.stdin.on('data', chunk => { data += chunk; if (data.includes('later')) { process.stdout.write(data); process.exit(0); } });";

        const managedProcess = await manager.start(ctx, {
            args: ["-e", script],
            command: process.execPath,
            cwd,
            initialStdin: "startup\n",
            maxOutputBytes: 4_096,
        });

        await expect(managedProcess.writeStdin(ctx, "later\n")).resolves.toBe(true);
        await expect(managedProcess.wait(ctx)).resolves.toMatchObject({
            exitCode: 0,
            stdout: "startup\nlater\n",
        });
    });

    it("accepts trusted startup input larger than the pipe high-water mark", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const startup = `${"x".repeat(128 * 1_024)}\n`;
        const script = [
            "process.stdin.setEncoding('utf8');",
            "let data = '';",
            "process.stdin.on('data', chunk => {",
            "  data += chunk;",
            "  if (data.endsWith('later\\n')) {",
            "    process.stdout.write(String(data.length));",
            "    process.exit(0);",
            "  }",
            "});",
        ].join("");

        const managedProcess = await manager.start(ctx, {
            args: ["-e", script],
            command: process.execPath,
            cwd,
            initialStdin: startup,
            maxOutputBytes: 4_096,
        });

        await expect(managedProcess.writeStdin(ctx, "later\n")).resolves.toBe(true);
        await expect(managedProcess.wait(ctx)).resolves.toMatchObject({
            exitCode: 0,
            stdout: String(startup.length + "later\n".length),
        });
    });

    it("delivers trusted startup input to a PTY without echoing it or consuming later input", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const readyMarker = "\u001eprivate-startup-ready\u001f";
        const completeMarker = "\u001eprivate-startup-complete\u001f";
        const startupInput = `${"p".repeat(128 * 1_024)}\n`;
        const script = [
            "terminal_state=$(stty -g)",
            "stty -echo -icanon min 1 time 0",
            'printf %s "$1"',
            "IFS= read -r startup",
            'stty "$terminal_state"',
            'printf %s "$2"',
            "IFS= read -r later",
            'printf "startup:%s;seen:%s" "${#startup}" "$later"',
        ].join("\n");

        const managedProcess = await manager.start(ctx, {
            args: ["-c", script, "private-startup", readyMarker, completeMarker],
            command: "/bin/sh",
            cwd,
            initialStdin: startupInput,
            initialStdinHandshake: { completeMarker, readyMarker },
            maxOutputBytes: 4_096,
            tty: true,
        });

        await expect(managedProcess.writeStdin(ctx, "later-input\n")).resolves.toBe(true);
        const result = await managedProcess.wait(ctx);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`startup:${String(startupInput.length - 1)}`);
        expect(result.stdout).toContain("seen:later-input");
        expect(result.stdout).not.toContain("p".repeat(32));
        expect(result.stdout).not.toContain(readyMarker);
        expect(result.stdout).not.toContain(completeMarker);
    });

    it("retains the head and tail and reports omitted bytes when output exceeds its cap", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);

        const result = await manager.run(ctx, {
            command: "printf 'oldest-newest'",
            cwd,
            maxOutputBytes: 6,
            timeoutMs: 2_000,
        });

        expect(result.stdout).toBe("old\n... 7 bytes omitted ...\nest");
        expect(result.stdoutBytes).toBe(13);
        expect(result.stdoutOmittedBytes).toBe(7);
    });

    it("honors direct read cursors without consuming their output", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const process = await manager.start(ctx, {
            command: "printf 'abcdef'",
            cwd,
            maxOutputBytes: 4_096,
        });
        await process.wait(ctx);

        expect(process.readOutput(2, 0)).toMatchObject({
            stdoutDelta: "cdef",
            stdoutDeltaBytes: 4,
            stdoutDeltaOmittedBytes: 0,
            stdoutOffset: 6,
        });
        expect(process.readOutput(2, 0).stdoutDelta).toBe("cdef");
    });

    it("kills timed out commands and removes them from tracking", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);

        const result = await manager.run(ctx, {
            command: `${nodeBinary()} -e ${shellQuote("setInterval(() => undefined, 1000);")}`,
            cwd,
            timeoutMs: 50,
            killGraceMs: 50,
            maxOutputBytes: 4_096,
        });

        expect(result.timedOut).toBe(true);
        expect(result.killed).toBe(true);
        expect(manager.activeCount()).toBe(0);
    });

    it("kills commands when their abort signal fires", async () => {
        const cwd = await makeTemporaryDirectory();
        const manager = new NativeProcessManager(ctx);
        const controller = new AbortController();
        const resultPromise = manager.run(ctx, {
            command: `${nodeBinary()} -e ${shellQuote("setInterval(() => undefined, 1000);")}`,
            cwd,
            timeoutMs: 2_000,
            killGraceMs: 50,
            maxOutputBytes: 4_096,
            signal: controller.signal,
        });

        controller.abort();
        const result = await resultPromise;

        expect(result.aborted).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.killed).toBe(true);
        expect(manager.activeCount()).toBe(0);
    });

    it("kills the process group for timed out shell descendants", async () => {
        const cwd = await makeTemporaryDirectory();
        const marker = join(cwd, "descendant-marker.txt");
        const manager = new NativeProcessManager(ctx);
        const writer = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 500);`;
        const blocker = "setInterval(() => undefined, 1000);";

        const result = await manager.run(ctx, {
            command: `${nodeBinary()} -e ${shellQuote(writer)} & ${nodeBinary()} -e ${shellQuote(blocker)}`,
            cwd,
            timeoutMs: 100,
            killGraceMs: 50,
            maxOutputBytes: 4_096,
        });

        expect(result.timedOut).toBe(true);
        await delay(700);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(manager.activeCount()).toBe(0);
    });
});

async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "compute-processes-"));
    temporaryDirectories.push(path);
    return path;
}

function nodeBinary(): string {
    return shellQuote(process.execPath);
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForProcessExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!isProcessAlive(pid)) return;
        await delay(10);
    }
    throw new Error(`Process ${String(pid)} remained alive after startup initialization failed.`);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
