import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMacOsSeatbeltCommand as createCommand } from "../../sources/sandbox/createMacOsSeatbeltCommand.js";

const temporaryDirectories: string[] = [];
const declaredHostPolicy = {
    protectedProjectFiles: ["agent-policy.toml", "fallback-policy.toml", "security-policy.md"],
    networkPolicyFiles: ["agent-policy.toml"],
    privatePathVariables: ["EMBEDDER_PRIVATE_PATH"],
};

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

function createMacOsSeatbeltCommand(
    options: Parameters<typeof createCommand>[0],
): ReturnType<typeof createCommand> {
    return createCommand({ hostPolicy: declaredHostPolicy, ...options });
}

describe("createMacOsSeatbeltCommand", () => {
    it("keeps the temporary directory writable in Read only mode without exposing the workspace", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-read-only-"));
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
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-workspace-write-"));
        temporaryDirectories.push(cwd);
        await mkdir(join(cwd, ".git"));
        await mkdir(join(cwd, "plans"));

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "workspace_write",
            deniedWritePaths: [join(cwd, "plans")],
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(await realpath(cwd));
        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(
            await realpath(join(cwd, ".git")),
        );
        expect(definedPaths(result.args, "PROTECTED_WRITE")).not.toContain(join(cwd, ".git"));
        expect(definedPaths(result.args, "PROTECTED_WRITE")).toEqual(
            expect.arrayContaining([
                join(cwd, "agent-policy.toml"),
                join(cwd, "fallback-policy.toml"),
                join(cwd, "security-policy.md"),
                join(cwd, "plans"),
            ]),
        );
    });

    it("uses a caller-provided private temp folder without reopening the shared host temp", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-private-temp-"));
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
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-no-subprocess-"));
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
        expect(result.args[1]).not.toContain('(allow network-outbound (remote ip "localhost:*"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it("allows unrestricted egress without implicitly allowing local binding", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkFullAccess: true,
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-outbound (remote ip "*:*"))');
        expect(result.args[1]).not.toContain('(allow network-bind (local ip "*:*"))');
        expect(result.args[1]).not.toContain('(allow network-inbound (local ip "*:*"))');
    });

    it("places explicit read denials after the broad host read grant", async () => {
        const denied = join(process.cwd(), "private");
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            deniedReadPaths: [denied],
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "DENIED_READ")).toContain(denied);
        expect(result.args[1]).toContain('(deny file-read*\n  (literal (param "DENIED_READ_0"))');
    });

    it("confines unix sockets to the project, leaving host sockets unreachable", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-sockets-"));
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
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-socket-order-"));
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

    it("grants one named socket outside the project without widening anything else", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-socket-grant-"));
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

    it("never grants an embedder-private socket even when a caller asks for it", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-socket-grant-order-"));
        temporaryDirectories.push(cwd);
        const control = join(cwd, "control", "server.sock");

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            environment: { EMBEDDER_PRIVATE_PATH: control },
            mode: "workspace_write",
            shell: "/bin/sh",
            unixSocketPaths: [control],
        });

        expect(definedPaths(result.args, "GRANTED_SOCKET")).toEqual([]);
    });

    it("lets a denied write root beat an exact socket grant", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-protected-socket-"));
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
            deniedWritePaths: [runtime],
            shell: "/bin/sh",
            unixSocketPaths: [granted],
        });

        expect(definedPaths(result.args, "GRANTED_SOCKET")).toEqual([]);
        expect(definedPaths(result.args, "WRITABLE_ROOT")).not.toContain(await realpath(runtime));
    });

    it("keeps sockets out of Read only commands and out of protected paths", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-socket-limits-"));
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
            environment: { EMBEDDER_PRIVATE_PATH: join(cwd, "control", "server.sock") },
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

    it("adds no product-specific project protections when the host policy is empty", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-seatbelt-empty-policy-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            hostPolicy: {},
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "PROTECTED_WRITE")).toEqual([]);
    });
});

function definedPaths(args: readonly string[], prefix: string): string[] {
    return args
        .filter((argument) => argument.startsWith(`-D${prefix}_`))
        .map((argument) => argument.slice(argument.indexOf("=") + 1));
}
