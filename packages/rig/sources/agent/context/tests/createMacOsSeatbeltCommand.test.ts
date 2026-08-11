import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createMacOsSeatbeltCommand } from "../createMacOsSeatbeltCommand.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("createMacOsSeatbeltCommand", () => {
    it("keeps the temporary directory writable in Read only mode without exposing the workspace", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-read-only-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
        });

        const writableRoots = definedPaths(result.args, "WRITABLE_ROOT");
        const canonicalTemporaryDirectory = await realpath(tmpdir());
        expect(writableRoots).toContain(canonicalTemporaryDirectory);
        expect(writableRoots).not.toContain(await realpath(cwd));
        expect(result.args[1]).toContain("(allow file-read*)");
    });

    it("makes the workspace writable in Workspace write mode", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-workspace-write-"));
        temporaryDirectories.push(cwd);
        await mkdir(join(cwd, ".git"));
        await mkdir(join(cwd, "plans"));

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "workspace_write",
            protectedPaths: [join(cwd, "plans")],
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(await realpath(cwd));
        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(
            await realpath(join(cwd, ".git")),
        );
        expect(definedPaths(result.args, "PROTECTED_WRITE")).not.toContain(join(cwd, ".git"));
        expect(definedPaths(result.args, "PROTECTED_WRITE")).toEqual(
            expect.arrayContaining([
                join(cwd, "rig.toml"),
                join(cwd, "happy.toml"),
                join(cwd, "AGENTS_SECURITY.md"),
                join(cwd, "plans"),
            ]),
        );
    });

    it("uses a caller-provided private temp folder without reopening the shared host temp", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-private-temp-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const privateTemporaryDirectory = join(root, "runtime", "tmp");
        await mkdir(cwd);
        await mkdir(privateTemporaryDirectory, { recursive: true });

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory: privateTemporaryDirectory,
        });

        const writableRoots = definedPaths(result.args, "WRITABLE_ROOT");
        expect(writableRoots).toContain(await realpath(privateTemporaryDirectory));
        expect(writableRoots).not.toContain(await realpath(tmpdir()));
        expect(writableRoots).not.toContain("/private/tmp");
    });

    it("can refuse subprocess creation for a contained background runtime", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-no-subprocess-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            allowSubprocesses: false,
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain("(deny process-fork)");
    });

    it("allows outbound network only to the managed proxy port", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkAllowedLoopbackPorts: [43_123],
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-outbound (remote ip "localhost:43123"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it("allows binding any local port without opening external egress", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkAllowLocalBinding: true,
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-bind (local ip "*:*"))');
        expect(result.args[1]).toContain('(allow network-inbound (local ip "localhost:*"))');
        expect(result.args[1]).toContain('(allow network-outbound (remote ip "localhost:*"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it("confines unix sockets to the project, leaving host sockets unreachable", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-sockets-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        const socketRoots = definedPaths(result.args, "PROJECT_SOCKET_ROOT");
        expect(socketRoots).toEqual([await realpath(cwd)]);
        expect(socketRoots).not.toContain(await realpath(tmpdir()));
        expect(result.args[1]).toContain("(allow system-socket (socket-domain AF_UNIX))");
        expect(result.args[1]).toContain(
            '(allow network-bind (local unix-socket (subpath (param "PROJECT_SOCKET_ROOT_0"))))',
        );
        expect(result.args[1]).toContain(
            '(allow network-outbound (remote unix-socket (subpath (param "PROJECT_SOCKET_ROOT_0"))))',
        );
    });

    it("refuses to grant sockets in the home folder, where host agents keep theirs", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: homedir(),
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "PROJECT_SOCKET_ROOT")).toEqual([]);
        expect(result.args[1]).not.toContain("(allow network-bind (local unix-socket");
    });

    it("orders protected denies after the socket allows, as last-match-wins requires", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-order-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        const policy = result.args[1] ?? "";
        expect(policy.indexOf("(allow network-bind (local unix-socket")).toBeLessThan(
            policy.indexOf("(deny network-outbound"),
        );
    });

    it.runIf(process.platform === "darwin")(
        "binds a socket in the project and is refused one beside it",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-runtime-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            await mkdir(cwd);
            const bind = (path: string) =>
                `node -e "const net=require('net');const s=net.createServer();s.listen('${path}',()=>{console.log('BOUND');s.close();});s.on('error',(e)=>{console.log('DENIED '+e.code);});"`;

            const inside = await createMacOsSeatbeltCommand({
                command: bind(join(cwd, "inside.sock")),
                cwd,
                mode: "workspace_write",
                shell: "/bin/sh",
            });
            const outside = await createMacOsSeatbeltCommand({
                command: bind(join(root, "outside.sock")),
                cwd,
                mode: "workspace_write",
                shell: "/bin/sh",
            });

            const allowed = await execFileAsync(inside.command, inside.args as string[], { cwd });
            const refused = await execFileAsync(outside.command, outside.args as string[], { cwd });
            expect(allowed.stdout).toContain("BOUND");
            expect(refused.stdout).toContain("DENIED");
        },
    );

    it("grants one named socket outside the project without widening anything else", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-grant-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        await mkdir(cwd);
        const granted = join(root, "runtime", "worklet.sock");

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
            unixSocketPaths: [granted],
        });

        const policy = result.args[1] ?? "";
        expect(definedPaths(result.args, "GRANTED_SOCKET")).toEqual([
            join(await realpath(root), "runtime", "worklet.sock"),
        ]);
        expect(policy).toContain(
            '(allow network-outbound (remote unix-socket (literal (param "GRANTED_SOCKET_0"))))',
        );
        // Connecting is granted; binding there and writing around it are not.
        expect(policy).not.toContain('(local unix-socket (literal (param "GRANTED_SOCKET_0")))');
        expect(policy).not.toContain('(subpath (param "GRANTED_SOCKET_0"))');
        expect(definedPaths(result.args, "WRITABLE_ROOT")).not.toContain(granted);
    });

    it("never grants Rig's own control socket even when a caller asks for it", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-grant-order-"));
        temporaryDirectories.push(cwd);
        const control = join(cwd, "control", "server.sock");

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            environment: { RIG_SERVER_SOCKET_PATH: control },
            mode: "workspace_write",
            shell: "/bin/sh",
            unixSocketPaths: [control],
        });

        expect(definedPaths(result.args, "GRANTED_SOCKET")).toEqual([]);
    });

    it("reopens one exact socket inside a broadly protected root", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-protected-socket-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const runtime = join(root, "runtime");
        const granted = join(runtime, "worklet.sock");
        await mkdir(cwd);
        await mkdir(runtime);

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            protectedPaths: [runtime],
            shell: "/bin/sh",
            unixSocketPaths: [granted],
        });

        const policy = result.args[1] ?? "";
        expect(policy.indexOf("(deny network-outbound")).toBeLessThan(
            policy.indexOf('(param "GRANTED_SOCKET_0")'),
        );
        expect(definedPaths(result.args, "WRITABLE_ROOT")).not.toContain(await realpath(runtime));
    });

    it.runIf(process.platform === "darwin")(
        "connects to a granted socket outside the project and is refused its neighbour",
        async () => {
            // A Unix socket address is a small fixed-size kernel field, so this path stays short.
            const root = await mkdtemp(join(tmpdir(), "rg"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const runtime = join(root, "runtime");
            await mkdir(cwd);
            await mkdir(runtime);
            const granted = join(runtime, "a.sock");
            const neighbour = join(runtime, "b.sock");
            const servers = await Promise.all([listen(granted), listen(neighbour)]);
            try {
                const connect = (path: string) =>
                    `node -e "const net=require('net');const c=net.connect('${path}');c.on('connect',()=>{console.log('CONNECTED');c.end();});c.on('error',(e)=>{console.log('DENIED '+e.code);});"`;

                const allowed = await createMacOsSeatbeltCommand({
                    command: connect(granted),
                    cwd,
                    mode: "workspace_write",
                    shell: "/bin/sh",
                    unixSocketPaths: [granted],
                });
                const refused = await createMacOsSeatbeltCommand({
                    command: connect(neighbour),
                    cwd,
                    mode: "workspace_write",
                    shell: "/bin/sh",
                    unixSocketPaths: [granted],
                });

                expect(
                    (await execFileAsync(allowed.command, allowed.args as string[], { cwd }))
                        .stdout,
                ).toContain("CONNECTED");
                expect(
                    (await execFileAsync(refused.command, refused.args as string[], { cwd }))
                        .stdout,
                ).toContain("DENIED");
            } finally {
                for (const server of servers) server.close();
            }
        },
    );

    it.runIf(process.platform === "darwin")(
        "grants full network access IP egress without granting the host's Unix sockets",
        async () => {
            // A Unix socket address is a small fixed-size kernel field, so this path stays short.
            const root = await mkdtemp(join(tmpdir(), "rg"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const elsewhere = join(root, "elsewhere");
            await mkdir(cwd);
            await mkdir(elsewhere);
            // Stands in for the host's own sockets: the Docker daemon, the ssh agent, gpg.
            const hostSocket = join(elsewhere, "h.sock");
            const server = await listen(hostSocket);
            try {
                const command = await createMacOsSeatbeltCommand({
                    command: `node -e "const net=require('net');const c=net.connect('${hostSocket}');c.on('connect',()=>{console.log('CONNECTED');c.end();});c.on('error',(e)=>{console.log('DENIED '+e.code);});"`,
                    cwd,
                    mode: "workspace_write",
                    networkFullAccess: true,
                    shell: "/bin/sh",
                });

                // Unrestricted egress is about IP. A socket nothing granted stays out of reach,
                // so asking for the network never quietly hands over the Docker daemon.
                expect(
                    (await execFileAsync(command.command, command.args as string[], { cwd }))
                        .stdout,
                ).toContain("DENIED");
                expect(command.args[1]).toContain('(allow network-outbound (remote ip "*:*"))');
                expect(command.args[1]).not.toContain("(allow network-outbound)");
            } finally {
                server.close();
            }
        },
    );

    it("keeps sockets out of Read only commands and out of protected paths", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-limits-"));
        temporaryDirectories.push(cwd);

        const readOnly = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
        });
        expect(definedPaths(readOnly.args, "PROJECT_SOCKET_ROOT")).toEqual([]);
        expect(readOnly.args[1]).not.toContain("(allow system-socket (socket-domain AF_UNIX))");
        expect(readOnly.args[1]).not.toContain("(allow network-bind (local unix-socket");

        const writable = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            environment: { RIG_SERVER_SOCKET_PATH: join(cwd, "control", "server.sock") },
            mode: "workspace_write",
            shell: "/bin/sh",
        });
        const protectedPaths = definedPaths(writable.args, "PROTECTED_WRITE");
        expect(protectedPaths).toContain(join(cwd, "control", "server.sock"));
        const protectedKey = `PROTECTED_WRITE_${String(
            protectedPaths.indexOf(join(cwd, "control", "server.sock")),
        )}`;
        expect(writable.args[1]).toContain(
            `(deny network-outbound\n  (remote unix-socket (literal (param "${protectedKey}")))`,
        );
    });

    it.runIf(process.platform === "darwin")(
        "allows a normal commit from a linked worktree in Workspace write mode",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-git-worktree-"));
            temporaryDirectories.push(root);
            const repository = join(root, "repository");
            const worktree = join(root, "worktree");
            await execFileAsync("git", ["init", repository]);
            await execFileAsync("git", [
                "-C",
                repository,
                "config",
                "user.email",
                "rig@example.com",
            ]);
            await execFileAsync("git", ["-C", repository, "config", "user.name", "Rig"]);
            await writeFile(join(repository, "tracked.txt"), "initial\n");
            await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
            await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
            await execFileAsync("git", [
                "-C",
                repository,
                "worktree",
                "add",
                "-b",
                "feature",
                worktree,
            ]);
            await writeFile(join(worktree, "tracked.txt"), "changed\n");

            const result = await createMacOsSeatbeltCommand({
                argv: ["git", "commit", "-am", "sandboxed commit"],
                command: "",
                cwd: worktree,
                mode: "workspace_write",
                shell: "/bin/sh",
            });

            await expect(
                execFileAsync(result.command, result.args as string[], { cwd: worktree }),
            ).resolves.toMatchObject({ stderr: expect.any(String), stdout: expect.any(String) });
        },
    );
});

function listen(path: string): Promise<{ close: () => void }> {
    const server = createServer();
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => resolve({ close: () => server.close() }));
    });
}

function definedPaths(args: readonly string[], prefix: string): string[] {
    return args
        .filter((argument) => argument.startsWith(`-D${prefix}_`))
        .map((argument) => argument.slice(argument.indexOf("=") + 1));
}
