import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { NativeProcessManager } from "../../../processes/index.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { createNodeAgentContext } from "../createNodeAgentContext.js";
import { SecretRegistry, SessionSecretContext } from "../../../secrets/index.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

describe("createNodeAgentContext", () => {
    const ctx = createTestRootContext().named("node-agent-context-test");
    afterEach(async () => {
        await Promise.all(
            tempDirs.splice(0).map((path) =>
                rm(path, {
                    recursive: true,
                    force: true,
                }),
            ),
        );
    });

    it("runs bash through the explicit process manager", async () => {
        const cwd = await makeTempDir();
        const processManager = new NativeProcessManager();
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager,
        });

        const result = await context.bash.run({
            command: "printf 'context-process'",
            timeoutMs: 2_000,
            maxOutputBytes: 4_096,
        });

        expect(result.stdout).toBe("context-process");
        expect(result.exitCode).toBe(0);
        expect(processManager.activeCount()).toBe(0);
    });

    it("injects the session Git identity into shell subprocesses", async () => {
        const cwd = await makeTempDir();
        const context = createNodeAgentContext(ctx, {
            cwd,
            environment: {
                ...process.env,
                GIT_AUTHOR_EMAIL: "steve@example.com",
                GIT_AUTHOR_NAME: "Steve Korshakov",
                GIT_COMMITTER_EMAIL: "steve@example.com",
                GIT_COMMITTER_NAME: "Steve Korshakov",
            },
            permissionMode: "full_access",
            processManager: new NativeProcessManager(),
        });
        const script =
            "process.stdout.write(JSON.stringify({authorEmail:process.env.GIT_AUTHOR_EMAIL,authorName:process.env.GIT_AUTHOR_NAME,committerEmail:process.env.GIT_COMMITTER_EMAIL,committerName:process.env.GIT_COMMITTER_NAME}))";

        const result = await context.bash.run({
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        });

        expect(JSON.parse(result.stdout)).toEqual({
            authorEmail: "steve@example.com",
            authorName: "Steve Korshakov",
            committerEmail: "steve@example.com",
            committerName: "Steve Korshakov",
        });
    });

    it("keeps a daemon-owned Git broker behind Full access", async () => {
        const cwd = await makeTempDir();
        const sockets = new Set<import("node:net").Socket>();
        const broker = createServer((socket) => {
            socket.end(
                "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nbroker-ok\n",
            );
        });
        broker.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
        });
        await new Promise<void>((resolve, reject) => {
            broker.once("error", reject);
            broker.listen(0, "127.0.0.1", () => {
                broker.off("error", reject);
                resolve();
            });
        });
        const address = broker.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing credential broker test port.");
        }
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager: new NativeProcessManager(),
        });
        const script = `const request=require("node:http").get("http://127.0.0.1:${String(address.port)}/",response=>response.pipe(process.stdout));request.setTimeout(2000,()=>request.destroy(new Error("timeout")));request.on("error",error=>{console.error(error.message);process.exitCode=1})`;

        try {
            const restricted = await context.bash.run({
                command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            });
            expect(restricted.exitCode).not.toBe(0);

            context.permissions!.setMode("full_access");
            const fullAccess = await context.bash.run({
                command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            });
            expect(fullAccess).toMatchObject({ exitCode: 0, stdout: "broker-ok\n" });
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => broker.close(() => resolve()));
        }
    }, 10_000);

    it("injects a broker capability only when the project Git secret is selected", async () => {
        const cwd = await makeTempDir();
        const capability = "c".repeat(64);
        let active = 0;
        let activations = 0;
        const secrets = new SessionSecretContext(new SecretRegistry());
        secrets.setRuntimeSecret({
            activate: () => {
                active += 1;
                activations += 1;
                return {
                    environment: {},
                    release: () => {
                        active -= 1;
                    },
                };
            },
            description: "Git access for this managed project",
            environment: {
                GIT_CONFIG_KEY_1: `url.http://127.0.0.1:41000/${capability}/github.com/slopus/rig.git.insteadOf`,
            },
            id: "project-git",
            trustedLoopbackPorts: [41_000],
        });
        const context = createNodeAgentContext(ctx, {
            cwd,
            permissionMode: "full_access",
            processManager: new NativeProcessManager(),
            secrets,
        });
        const command = 'printf %s "${GIT_CONFIG_KEY_1-}"';

        await expect(context.bash.run({ command })).resolves.toMatchObject({ stdout: "" });
        expect({ active, activations }).toEqual({ active: 0, activations: 0 });
        await expect(
            context.bash.run({ command, secrets: ["project-git"] }),
        ).resolves.toMatchObject({
            stdout: "url.http://127.0.0.1/[Rig Git authentication]/github.com/slopus/rig.git.insteadOf",
        });
        expect({ active, activations }).toEqual({ active: 0, activations: 1 });
    });

    it("rejects attacker-selected shells outside Full access", async () => {
        const cwd = await makeTempDir();
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager: new NativeProcessManager(),
        });

        for (const mode of ["workspace_write", "read_only", "auto"] as const) {
            context.permissions?.setMode(mode);
            await expect(
                context.bash.run({ command: "printf blocked", shell: "/bin/sh" }),
            ).rejects.toThrow("Custom shells are available only in Full access mode.");
        }

        context.permissions?.setMode("full_access");
        await expect(
            context.bash.run({ command: "printf allowed", shell: "/bin/sh" }),
        ).resolves.toMatchObject({ exitCode: 0, stdout: "allowed" });
    });

    it("does not inherit provider or control-channel secrets in shell subprocesses", async () => {
        const cwd = await makeTempDir();
        const previousToken = process.env.RIG_GYM_TOKEN;
        const previousUrl = process.env.RIG_GYM_INFERENCE_URL;
        const previousSafeValue = process.env.SHELL_SAFE_TEST_VALUE;
        process.env.RIG_GYM_TOKEN = "synthetic-gym-secret";
        process.env.RIG_GYM_INFERENCE_URL = "http://control-channel.invalid";
        process.env.SHELL_SAFE_TEST_VALUE = "ordinary-value";

        try {
            const context = createNodeAgentContext(ctx, {
                cwd,
                permissionMode: "full_access",
                processManager: new NativeProcessManager(),
            });
            const script =
                "process.stdout.write(JSON.stringify({token:process.env.RIG_GYM_TOKEN,url:process.env.RIG_GYM_INFERENCE_URL,safe:process.env.SHELL_SAFE_TEST_VALUE}))";
            const result = await context.bash.run({
                command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            });

            expect(JSON.parse(result.stdout)).toEqual({ safe: "ordinary-value" });
        } finally {
            restoreEnvironment("RIG_GYM_TOKEN", previousToken);
            restoreEnvironment("RIG_GYM_INFERENCE_URL", previousUrl);
            restoreEnvironment("SHELL_SAFE_TEST_VALUE", previousSafeValue);
        }
    });

    it("injects selected attached bundles and masks every attached ambient destination", async () => {
        const cwd = await makeTempDir();
        const environmentVariables = [
            "MANAGED_SECRET_TEST_TOKEN",
            "MANAGED_SECRET_TEST_REGION",
            "MANAGED_DATABASE_TEST_URL",
        ] as const;
        const previousValues = environmentVariables.map((name) => process.env[name]);
        for (const name of environmentVariables) process.env[name] = `ambient-${name}`;
        const registry = new SecretRegistry([
            {
                description: "Service API credentials",
                environment: {
                    MANAGED_SECRET_TEST_REGION: "registered-region",
                    MANAGED_SECRET_TEST_TOKEN: "registered-token",
                },
                id: "service",
            },
            {
                description: "Database credentials",
                environment: { MANAGED_DATABASE_TEST_URL: "registered-database-url" },
                id: "database",
            },
        ]);
        const secrets = new SessionSecretContext(registry, ["service"], ["database"]);
        const context = createNodeAgentContext(ctx, {
            cwd,
            permissionMode: "full_access",
            processManager: new NativeProcessManager(),
            secrets,
        });
        const script = `process.stdout.write(JSON.stringify({database:process.env.MANAGED_DATABASE_TEST_URL,region:process.env.MANAGED_SECRET_TEST_REGION,token:process.env.MANAGED_SECRET_TEST_TOKEN}))`;
        const printSecrets = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

        try {
            const omitted = await context.bash.run({ command: printSecrets });
            const empty = await context.bash.run({ command: printSecrets, secrets: [] });
            const serviceOnly = await context.bash.run({
                command: printSecrets,
                secrets: ["service"],
            });
            const selected = await context.bash.run({
                command: printSecrets,
                secrets: ["service", "database"],
            });

            expect(JSON.parse(omitted.stdout)).toEqual({});
            expect(JSON.parse(empty.stdout)).toEqual({});
            expect(JSON.parse(serviceOnly.stdout)).toEqual({
                region: "registered-region",
                token: "registered-token",
            });
            expect(JSON.parse(selected.stdout)).toEqual({
                database: "registered-database-url",
                region: "registered-region",
                token: "registered-token",
            });
        } finally {
            environmentVariables.forEach((name, index) =>
                restoreEnvironment(name, previousValues[index]),
            );
        }
    });

    it("rejects command secrets unless the exact command has Full access", async () => {
        const cwd = await makeTempDir();
        const registry = new SecretRegistry([
            {
                description: "Service API credentials",
                environment: { MANAGED_SECRET_TEST_TOKEN: "registered-token" },
                id: "service",
            },
        ]);
        const context = createNodeAgentContext(ctx, {
            cwd,
            permissionMode: "auto",
            processManager: new NativeProcessManager(),
            secrets: new SessionSecretContext(registry, ["service"]),
        });

        await expect(context.bash.run({ command: "true", secrets: ["service"] })).rejects.toThrow(
            "Secrets require Full access",
        );
        context.permissions?.setMode("full_access");
        await expect(
            context.bash.run({ command: "true", secrets: ["service"] }),
        ).resolves.toMatchObject({ exitCode: 0 });

        const sessionId = await context.bash.startSession({
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
            secrets: ["service"],
        });
        context.permissions?.setMode("workspace_write");
        await expect(context.bash.writeSession(sessionId, "git push\n")).rejects.toThrow(
            "Secrets require Full access",
        );
        context.permissions?.setMode("full_access");
        await context.bash.killSession(sessionId);
    });

    it("keeps yielded shell sessions alive for polling and stdin", async () => {
        const cwd = await makeTempDir();
        const processManager = new NativeProcessManager();
        const context = createNodeAgentContext(ctx, { cwd, processManager });
        const script = [
            'process.stdin.setEncoding("utf8")',
            'process.stdin.once("data", data => { process.stdout.write("received:" + data.trim()); process.exit(0) })',
        ].join(";");
        const sessionId = await context.bash.startSession({
            command: `${JSON.stringify(process.execPath)} -e '${script}'`,
            maxOutputBytes: 4_096,
        });

        await expect(context.bash.readSession(sessionId, { waitMs: 50 })).resolves.toMatchObject({
            sessionId,
            status: "running",
        });
        await expect(context.bash.writeSession(sessionId, "hello\n")).resolves.toBe(true);
        const completed = await context.bash.readSession(sessionId, { waitMs: 2_000 });

        expect(completed).toMatchObject({
            exitCode: 0,
            status: "completed",
            stdout: "received:hello",
            stdoutDelta: "received:hello",
        });
        await expect(context.bash.readSession(sessionId)).resolves.toMatchObject({
            stdout: "received:hello",
            stdoutDelta: "",
        });
        expect(processManager.activeCount()).toBe(0);
    });

    it("reports only background session lifecycle changes", async () => {
        const cwd = await makeTempDir();
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager: new NativeProcessManager(),
        });
        const counts: number[] = [];
        context.bash.setActiveSessionCountListener?.((count) => counts.push(count));

        await context.bash.run({ command: "printf foreground", timeoutMs: 2_000 });
        expect(counts).toEqual([0]);

        const sessionId = await context.bash.startSession({ command: "sleep 0.05" });
        expect(counts).toEqual([0, 1]);
        await context.bash.readSession(sessionId, { waitMs: 2_000 });
        expect(counts).toEqual([0, 1, 0]);
    });

    it("leaves a background shell session running when a read gives up waiting", async () => {
        const cwd = await makeTempDir();
        const processManager = new NativeProcessManager();
        const context = createNodeAgentContext(ctx, { cwd, processManager });
        const sessionId = await context.bash.startSession({
            command: `${JSON.stringify(process.execPath)} -e 'setInterval(() => undefined, 1000)'`,
        });

        // Waiting is waiting, not a deadline: giving up on the read must not
        // take the command down with it.
        await expect(context.bash.readSession(sessionId, { waitMs: 50 })).resolves.toMatchObject({
            status: "running",
            timedOut: false,
        });
        expect(processManager.activeCount()).toBe(1);

        await context.bash.killSession(sessionId);
        await expect(context.bash.readSession(sessionId)).resolves.toMatchObject({
            status: "killed",
        });
    });

    it("enforces filesystem permissions across traversal and symlink escapes", async () => {
        const root = await makeWorkspaceRoot();
        const cwd = join(root, "workspace");
        const outside = join(root, "outside.txt");
        await mkdir(cwd);
        await writeFile(outside, "original");
        await symlink(outside, join(cwd, "outside-link"));
        await symlink(join(root, "missing-outside.txt"), join(cwd, "broken-outside-link"));
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager: new NativeProcessManager(),
        });

        await context.fs.writeFile(join(cwd, "inside.txt"), "inside");
        await context.fs.writeFile("relative.txt", "relative");
        await expect(readFile(join(cwd, "relative.txt"), "utf8")).resolves.toBe("relative");
        await expect(
            context.fs.writeFile(join(cwd, "..", "escaped.txt"), "escape"),
        ).rejects.toThrow("outside");
        await expect(context.fs.writeFile(join(cwd, "outside-link"), "escape")).rejects.toThrow(
            "outside",
        );
        await expect(
            context.fs.writeFile(join(cwd, "broken-outside-link"), "escape"),
        ).rejects.toThrow("outside");

        context.permissions?.setMode("read_only");
        await expect(context.fs.writeFile(join(cwd, "blocked.txt"), "blocked")).rejects.toThrow(
            "read-only",
        );

        context.permissions?.setMode("full_access");
        await context.fs.writeFile(outside, "full access");
        expect(await readFile(outside, "utf8")).toBe("full access");
    });

    it("keeps Auto mode workspace-scoped outside a reviewed call", async () => {
        const root = await makeWorkspaceRoot();
        const cwd = join(root, "workspace");
        const outside = join(root, "outside.txt");
        await mkdir(cwd);
        const context = createNodeAgentContext(ctx, {
            cwd,
            permissionMode: "auto",
            processManager: new NativeProcessManager(),
        });

        await context.fs.writeFile("inside.txt", "inside");
        await expect(context.fs.writeFile(outside, "blocked")).rejects.toThrow("outside");
        const sandboxedShell = await context.bash.run({
            command: "printf blocked > ../outside-shell.txt",
        });
        expect(sandboxedShell.exitCode).not.toBe(0);
        await context.permissions?.runWithMode("full_access", () =>
            context.fs.writeFile(outside, "reviewed"),
        );
        await context.permissions?.runWithMode("full_access", () =>
            context.bash.run({ command: "printf reviewed > ../outside-shell.txt" }),
        );

        await expect(readFile(join(cwd, "inside.txt"), "utf8")).resolves.toBe("inside");
        await expect(readFile(outside, "utf8")).resolves.toBe("reviewed");
        await expect(readFile(join(root, "outside-shell.txt"), "utf8")).resolves.toBe("reviewed");
        expect(context.permissions?.mode).toBe("auto");
    });

    it("sandboxes shell writes unless Full access is selected", async () => {
        const root = await makeWorkspaceRoot();
        const cwd = join(root, "workspace");
        await mkdir(cwd);
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager: new NativeProcessManager(),
        });

        const inside = await context.bash.run({ command: "printf inside > inside.txt" });
        const escaped = await context.bash.run({ command: "printf escaped > ../escaped.txt" });
        const escapedThroughCwd = await context.bash.run({
            command: "printf escaped > escaped-cwd.txt",
            cwd: root,
        });
        expect(inside.exitCode).toBe(0);
        expect(escaped.exitCode).not.toBe(0);
        expect(escapedThroughCwd.exitCode).not.toBe(0);
        await expect(readFile(join(cwd, "inside.txt"), "utf8")).resolves.toBe("inside");
        await expect(readFile(join(root, "escaped.txt"), "utf8")).rejects.toThrow();
        await expect(readFile(join(root, "escaped-cwd.txt"), "utf8")).rejects.toThrow();

        context.permissions?.setMode("read_only");
        const readOnly = await context.bash.run({ command: "printf blocked > blocked.txt" });
        expect(readOnly.exitCode).not.toBe(0);

        context.permissions?.setMode("full_access");
        const fullAccess = await context.bash.run({ command: "printf allowed > ../allowed.txt" });
        expect(fullAccess.exitCode).toBe(0);
        await expect(readFile(join(root, "allowed.txt"), "utf8")).resolves.toBe("allowed");
    });

    it.runIf(process.platform === "darwin" || process.platform === "linux")(
        "lets Git read global configuration and write repository metadata",
        async () => {
            const root = await makeWorkspaceRoot();
            const cwd = join(root, "workspace");
            const home = join(root, "home");
            const globalConfig = join(home, ".gitconfig");
            const globalIgnore = join(home, ".gitignore_global");
            await mkdir(cwd);
            await mkdir(home);
            await execFileAsync("git", ["init", "--quiet", cwd]);
            await writeFile(globalIgnore, "ignored-by-global-config.txt\n");
            await writeFile(globalConfig, `[core]\n\texcludesfile = ${globalIgnore}\n`);
            await writeFile(join(cwd, "ignored-by-global-config.txt"), "ignored\n");
            const context = createNodeAgentContext(ctx, {
                cwd,
                permissionMode: "workspace_write",
                processManager: new NativeProcessManager(),
            });

            // Keep the fixture scoped to Git so the login shell starts with the real home.
            const status = await context.bash.run({
                command: `GIT_CONFIG_GLOBAL=${JSON.stringify(globalConfig)} git status --short`,
            });
            expect(status).toMatchObject({ exitCode: 0, stderr: "", stdout: "" });

            const gitMetadataWrite = await context.bash.run({
                command: "printf '[core]\\n' > .git/config",
            });
            expect(gitMetadataWrite.exitCode).toBe(0);
            await expect(readFile(join(cwd, ".git", "config"), "utf8")).resolves.toBe("[core]\n");

            const outsideWrite = await context.bash.run({
                command: `printf blocked > ${JSON.stringify(join(home, "blocked.txt"))}`,
            });
            expect(outsideWrite.exitCode).not.toBe(0);
            await expect(readFile(join(home, "blocked.txt"), "utf8")).rejects.toThrow();
        },
    );

    it.runIf(process.platform === "darwin")(
        "keeps Rig control paths protected inside the writable temporary directory",
        async () => {
            const cwd = await makeWorkspaceRoot();
            const controlDirectory = await makeTempDir();
            const tokenPath = join(controlDirectory, "token");
            const previousTokenPath = process.env.RIG_SERVER_TOKEN_PATH;
            process.env.RIG_SERVER_TOKEN_PATH = tokenPath;

            try {
                const context = createNodeAgentContext(ctx, {
                    cwd,
                    permissionMode: "workspace_write",
                    processManager: new NativeProcessManager(),
                });
                const result = await context.bash.run({
                    command: `printf poisoned > ${JSON.stringify(tokenPath)}`,
                });

                expect(result.exitCode).not.toBe(0);
                await expect(readFile(tokenPath, "utf8")).rejects.toThrow();
            } finally {
                restoreEnvironment("RIG_SERVER_TOKEN_PATH", previousTokenPath);
            }
        },
    );

    it.runIf(process.platform === "darwin")(
        "does not grant writes through an unvalidated Git metadata link",
        async () => {
            const root = await makeWorkspaceRoot();
            const cwd = join(root, "workspace");
            const metadata = join(root, "metadata");
            await mkdir(cwd);
            await mkdir(metadata);
            await writeFile(join(metadata, "config"), "protected\n");
            await symlink(metadata, join(cwd, ".git"));
            const context = createNodeAgentContext(ctx, {
                cwd,
                permissionMode: "workspace_write",
                processManager: new NativeProcessManager(),
            });

            const writeTarget = await context.bash.run({
                command: "printf poisoned > .git/config",
            });

            expect(writeTarget.exitCode).not.toBe(0);
            await expect(readFile(join(cwd, ".git", "config"), "utf8")).resolves.toBe(
                "protected\n",
            );
        },
    );

    it("blocks shell network access unless Full access is selected", async () => {
        const cwd = await makeTempDir();
        const context = createNodeAgentContext(ctx, {
            cwd,
            processManager: new NativeProcessManager(),
        });
        const server = createServer((socket) => {
            socket.on("error", () => undefined);
            socket.end("connected");
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        try {
            const address = server.address() as AddressInfo;
            const script = [
                `const socket = require("node:net").connect(${address.port}, "127.0.0.1")`,
                "socket.setTimeout(1000)",
                'socket.on("connect", () => process.exit(0))',
                'socket.on("error", () => process.exit(2))',
                'socket.on("timeout", () => process.exit(3))',
            ].join(";");
            const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

            const sandboxed = await context.bash.run({ command, timeoutMs: 3_000 });
            expect(sandboxed.exitCode).not.toBe(0);

            context.permissions?.setMode("full_access");
            const fullAccess = await context.bash.run({ command, timeoutMs: 3_000 });
            expect(fullAccess.exitCode).toBe(0);
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
        }
    });
});

async function makeTempDir(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "rig-context-"));
    tempDirs.push(path);
    return path;
}

async function makeWorkspaceRoot(): Promise<string> {
    const path = await mkdtemp(join(process.cwd(), ".rig-context-"));
    tempDirs.push(path);
    return path;
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
