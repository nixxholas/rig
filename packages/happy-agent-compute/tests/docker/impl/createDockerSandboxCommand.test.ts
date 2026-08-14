import { describe, expect, it } from "vitest";

import {
    createDockerNetworkRelayScript,
    createDockerSandboxCommand,
} from "../../../sources/docker/impl/createDockerSandboxCommand.js";

const runtime = { bwrapPath: "/usr/bin/bwrap" };

describe("createDockerSandboxCommand", () => {
    it("bridges managed proxy sockets without sharing the container network", () => {
        const command = createDockerSandboxCommand({
            command: "curl https://example.com",
            commandCwd: "/workspace",
            mode: "workspace_write",
            networkBridgeRoot: "/workspace/.compute-network",
            networkUnixProxySockets: {
                authenticationToken: "command-secret",
                http: "/workspace/.compute-network/command-1/http.sock",
                loopback: [
                    {
                        path: "/workspace/.compute-network/command-1/loopback-443.sock",
                        port: 443,
                    },
                ],
                socks: "/workspace/.compute-network/command-1/socks.sock",
            },
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(command).toContain("--unshare-net");
        expect(bindMode(command, "/workspace/.compute-network")).toBe("--ro-bind");
        expect(lastBindIndex(command, "/workspace/.compute-network")).toBeGreaterThan(
            lastBindIndex(command, "/workspace"),
        );
        const script = command.at(-1);
        expect(script).toContain("Managed network access requires socat on PATH.");
        expect(script).toContain("TCP-LISTEN:3128,bind=127.0.0.1");
        expect(script).toContain("TCP-LISTEN:1080,bind=127.0.0.1");
        expect(script).toContain("TCP-LISTEN:443,bind=127.0.0.1");
        expect(script).toContain("command-secret");
        expect(script).toContain("kill $COMPUTE_INTERNAL_NETWORK_RELAY_PIDS");
        expect(script).toContain("curl https://example.com");
    });

    it("starts only selected loopback relays for a Full access command", () => {
        const script = createDockerNetworkRelayScript(
            "git fetch origin",
            {
                authenticationToken: "command-secret",
                http: "/workspace/.compute-network/command-1/http.sock",
                loopback: [
                    {
                        path: "/workspace/.compute-network/command-1/loopback-443.sock",
                        port: 443,
                    },
                ],
                socks: "/workspace/.compute-network/command-1/socks.sock",
            },
            { includeProxyPorts: false },
        );

        expect(script).toContain("TCP-LISTEN:443,bind=127.0.0.1");
        expect(script).not.toContain("TCP-LISTEN:3128");
        expect(script).not.toContain("TCP-LISTEN:1080");
    });

    it("makes the workspace read-only and isolates networking in Read only mode", () => {
        const command = createDockerSandboxCommand({
            command: "touch changed.txt",
            commandCwd: "/workspace",
            mode: "read_only",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(command).toContain("--unshare-net");
        expect(command).toContain("--unshare-pid");
        expect(command).toContain("--unshare-user");
        const procMount = command.findIndex(
            (argument, index) => argument === "/proc" && command[index - 1] === "--tmpfs",
        );
        expect(command.slice(procMount - 1, procMount + 1)).toEqual(["--tmpfs", "/proc"]);
        expect(bindMode(command, "/workspace")).toBeUndefined();
        expect(command.slice(-3)).toEqual(["/bin/sh", "-lc", "touch changed.txt"]);
    });

    it("keeps Full access filesystem writes while isolating withheld local binding", () => {
        const command = createDockerSandboxCommand({
            command: "node server.js",
            commandCwd: "/workspace",
            isolateNetwork: true,
            mode: "full_access",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(bindMode(command, "/")).toBe("--bind");
        expect(command).toContain("--unshare-net");
    });

    it("shares container networking when egress and local binding are both granted", () => {
        const command = createDockerSandboxCommand({
            command: "node server.js",
            commandCwd: "/workspace",
            isolateNetwork: false,
            mode: "workspace_write",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(command).not.toContain("--unshare-net");
        expect(bindMode(command, "/workspace")).toBe("--bind");
    });

    it("rebinds a Read only workspace below /tmp after the private tmpfs mount", () => {
        const command = createDockerSandboxCommand({
            command: "pwd",
            commandCwd: "/tmp/workspace",
            mode: "read_only",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/tmp/workspace",
        });

        const temporaryMount = mountIndex(command, "--tmpfs", "/tmp");
        const restoredMount = mountIndex(command, "--ro-bind", "/tmp/workspace", "/tmp/workspace");
        expect(restoredMount).toBeGreaterThan(temporaryMount);
    });

    it("makes only the workspace and temporary directory writable in Workspace write mode", () => {
        const command = createDockerSandboxCommand({
            command: "touch changed.txt",
            commandCwd: "/workspace/packages/service",
            mode: "workspace_write",
            protectedProjectFiles: ["product.policy"],
            protectedPaths: ["/workspace/plans"],
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(bindMode(command, "/")).toBe("--ro-bind");
        expect(bindMode(command, "/tmp")).toBeUndefined();
        expect(bindMode(command, "/workspace")).toBe("--bind");
        expect(command.filter((argument) => argument === "--tmpfs")).toHaveLength(2);
        expect(bindMode(command, "/workspace/.git")).toBeUndefined();
        expect(bindMode(command, "/workspace/product.policy")).toBe("--ro-bind-try");
        expect(bindMode(command, "/workspace/plans")).toBe("--ro-bind-try");
        expect(command.slice(command.indexOf("--chdir"), command.indexOf("--chdir") + 2)).toEqual([
            "--chdir",
            "/workspace/packages/service",
        ]);
    });

    it("adds granted write roots before write denials so denial wins", () => {
        const command = createDockerSandboxCommand({
            command: "touch /cache/private/result",
            commandCwd: "/workspace",
            mode: "workspace_write",
            protectedPaths: ["/cache/private"],
            runtime,
            shell: "/bin/sh",
            writablePaths: ["/cache"],
            workspaceCwd: "/workspace",
        });

        expect(bindMode(command, "/cache")).toBe("--bind-try");
        expect(bindMode(command, "/cache/private")).toBe("--ro-bind-try");
        expect(lastBindIndex(command, "/cache/private")).toBeGreaterThan(
            lastBindIndex(command, "/cache"),
        );
    });

    it("masks denied reads after writable mounts", () => {
        const command = createDockerSandboxCommand({
            command: "cat private/token",
            commandCwd: "/workspace",
            deniedReadPaths: [{ kind: "directory", path: "/workspace/private" }],
            mode: "workspace_write",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(mountIndex(command, "--tmpfs", "/workspace/private")).toBeGreaterThan(
            lastBindIndex(command, "/workspace"),
        );
        expect(mountIndex(command, "--remount-ro", "/workspace/private")).toBeGreaterThan(
            lastBindIndex(command, "/workspace"),
        );
    });

    it("atomically mounts the prepared project config over the writable workspace", () => {
        const command = createDockerSandboxCommand({
            command: "printf compromised > access.conf",
            commandCwd: "/workspace",
            mode: "workspace_write",
            protectedProjectFiles: ["access.conf", "secondary.policy", "security.policy"],
            readyNetworkPolicyFiles: ["access.conf"],
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(
            mountIndex(command, "--ro-bind", "/workspace/access.conf", "/workspace/access.conf"),
        ).toBeGreaterThan(lastBindIndex(command, "/workspace"));
        expect(
            mountIndex(
                command,
                "--ro-bind-try",
                "/workspace/secondary.policy",
                "/workspace/secondary.policy",
            ),
        ).toBeGreaterThan(lastBindIndex(command, "/workspace"));
        expect(
            mountIndex(
                command,
                "--ro-bind-try",
                "/workspace/security.policy",
                "/workspace/security.policy",
            ),
        ).toBeGreaterThan(lastBindIndex(command, "/workspace"));
        expect(
            mountIndex(
                command,
                "--ro-bind-try",
                "/workspace/access.conf",
                "/workspace/access.conf",
            ),
        ).toBe(-1);
    });

    it("refuses managed sockets outside the protected bridge root", () => {
        expect(() =>
            createDockerSandboxCommand({
                command: "curl https://example.com",
                commandCwd: "/workspace",
                mode: "workspace_write",
                networkBridgeRoot: "/workspace/.compute-network",
                networkUnixProxySockets: {
                    authenticationToken: "command-secret",
                    http: "/workspace/elsewhere/http.sock",
                    socks: "/workspace/.compute-network/command-1/socks.sock",
                },
                runtime,
                shell: "/bin/sh",
                workspaceCwd: "/workspace",
            }),
        ).toThrow("must be inside the protected bridge root");
    });
});

function bindMode(command: readonly string[], target: string): string | undefined {
    const targetIndex = lastBindIndex(command, target);
    return targetIndex < 2 ? undefined : command[targetIndex - 2];
}

function lastBindIndex(command: readonly string[], target: string): number {
    return command.findLastIndex(
        (argument, index) => argument === target && command[index - 1] === target,
    );
}

function mountIndex(
    command: readonly string[],
    mode: string,
    sourceOrTarget: string,
    target?: string,
): number {
    return command.findIndex(
        (argument, index) =>
            argument === mode &&
            command[index + 1] === sourceOrTarget &&
            (target === undefined || command[index + 2] === target),
    );
}
