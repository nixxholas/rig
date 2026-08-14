import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLinuxBubblewrapCommand as createCommand } from "../../sources/sandbox/createLinuxBubblewrapCommand.js";

const temporaryDirectories: string[] = [];
const projectConfigPlaceholders: NonNullable<
    Awaited<ReturnType<typeof createCommand>>["projectConfigPlaceholders"]
>[number][] = [];
const declaredHostPolicy = {
    protectedProjectFiles: [
        ".agent-state",
        ".agent-cache",
        "agent-policy.toml",
        "fallback-policy.toml",
        "security-policy.md",
    ],
    networkPolicyFiles: ["agent-policy.toml"],
    privatePathVariables: ["EMBEDDER_TOKEN_PATH"],
};

afterEach(async () => {
    await Promise.all(
        projectConfigPlaceholders.splice(0).map((placeholder) => placeholder.close()),
    );
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function createLinuxBubblewrapCommand(
    options: Parameters<typeof createCommand>[0],
): ReturnType<typeof createCommand> {
    const result = await createCommand({
        hostPolicy: declaredHostPolicy,
        ...options,
    });
    projectConfigPlaceholders.push(...(result.projectConfigPlaceholders ?? []));
    return result;
}

describe("createLinuxBubblewrapCommand", () => {
    it("bridges only managed proxy and loopback ports into the isolated network", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-network-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "curl https://example.com",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            networkUnixProxySockets: {
                authenticationToken: "command-secret",
                http: "/tmp/agent-compute-network/http.sock",
                loopback: [{ path: "/tmp/agent-compute-network/loopback-443.sock", port: 443 }],
                socks: "/tmp/agent-compute-network/socks.sock",
            },
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        });

        expect(result.args).toContain("--unshare-net");
        const bridgeMount = result.args.findIndex(
            (argument, index) =>
                argument === "/dev/agent-compute-network" && result.args[index - 2] === "--ro-bind",
        );
        expect(result.args.slice(bridgeMount - 2, bridgeMount + 1)).toEqual([
            "--ro-bind",
            "/tmp/agent-compute-network",
            "/dev/agent-compute-network",
        ]);
        expect(result.args).toContain("--tmpfs");
        const script = result.args.at(-1);
        expect(script).toContain("Managed network access requires socat on PATH.");
        expect(script).toContain("TCP-LISTEN:3128,bind=127.0.0.1");
        expect(script).toContain("/dev/agent-compute-network/http.sock");
        expect(script).not.toContain("/tmp/agent-compute-network/http.sock");
        expect(script).toContain("command-secret");
        expect(script).toContain("TCP-LISTEN:1080,bind=127.0.0.1");
        expect(script).toContain("TCP-LISTEN:443,bind=127.0.0.1");
        expect(script).toContain("curl https://example.com");
    });

    it("does not re-expose the host /tmp after installing the private network tmpfs", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-private-tmp-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            networkUnixProxySockets: {
                authenticationToken: "command-secret",
                http: "/tmp/agent-compute-network/http.sock",
                socks: "/tmp/agent-compute-network/socks.sock",
            },
            shell: "/bin/sh",
            temporaryDirectory: "/tmp",
        });

        expect(result.args).toContain("--tmpfs");
        expect(bindMode(result.args, await realpath("/tmp"))).toBeUndefined();
    });

    it("keeps host /tmp private even when the command has no managed network policy", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-private-default-tmp-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory: "/tmp",
        });

        expect(result.args).toContain("--tmpfs");
        expect(bindMode(result.args, await realpath("/tmp"))).toBeUndefined();
    });

    it("keeps protected project files read-only when the workspace is below /tmp", async () => {
        const privateTemporaryRoot = await realpath("/tmp");
        const root = await mkdtemp(
            join(privateTemporaryRoot, "agent-compute-bwrap-protected-project-"),
        );
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, ".agent-state")),
            mkdir(join(root, ".agent-cache")),
            mkdir(join(root, "plans")),
            writeFile(join(root, "agent-policy.toml"), "[network]\n"),
            writeFile(join(root, "fallback-policy.toml"), "[network]\n"),
            writeFile(join(root, "security-policy.md"), "Require approval.\n"),
        ]);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            deniedWritePaths: [join(root, "plans"), join(root, "missing")],
            shell: "/bin/sh",
            temporaryDirectory: privateTemporaryRoot,
        });

        for (const name of [
            ".agent-state",
            ".agent-cache",
            "agent-policy.toml",
            "fallback-policy.toml",
            "security-policy.md",
            "plans",
        ]) {
            expect(bindMode(result.args, join(root, name))).toBe("--ro-bind");
        }
        expect(bindMode(result.args, join(root, "missing"))).toBeUndefined();
        expect(result.protectedCreatePaths).toContain(join(root, "missing"));
    });

    it("hides a denied read after mounting the writable workspace", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-denied-read-"));
        temporaryDirectories.push(root);
        const denied = join(root, "private.txt");
        await writeFile(denied, "secret");

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            deniedReadPaths: [denied],
            mode: "workspace_write",
            protectProjectMetadata: false,
            shell: "/bin/sh",
        });

        expect(mountIndex(result.args, "--ro-bind", "/dev/null", denied)).toBeGreaterThan(
            mountIndex(result.args, "--bind", root, root),
        );
    });

    it("rebinds a Read only workspace below /tmp after the private tmpfs mount", async () => {
        const privateTemporaryRoot = await realpath("/tmp");
        const root = await mkdtemp(
            join(privateTemporaryRoot, "agent-compute-bwrap-read-only-project-"),
        );
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "pwd",
            commandCwd: root,
            cwd: root,
            mode: "read_only",
            shell: "/bin/sh",
            temporaryDirectory: privateTemporaryRoot,
        });

        const temporaryMount = mountIndex(result.args, "--tmpfs", "/tmp");
        const restoredMount = mountIndex(result.args, "--ro-bind", root, root);
        expect(restoredMount).toBeGreaterThan(temporaryMount);
    });

    it("uses a read-only host view with isolated networking in Read only mode", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-read-only-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "git status --short",
            commandCwd: root,
            cwd: root,
            mode: "read_only",
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        });

        expect(result.command).toBe("/usr/bin/bwrap");
        expect(bindMode(result.args, "/")).toBe("--ro-bind");
        expect(bindMode(result.args, root)).toBe(
            isAtOrBelow(await realpath("/tmp"), root) ? "--ro-bind" : undefined,
        );
        expect(result.args).toContain("--unshare-net");
        expect(result.args).toContain("--unshare-user");
        expect(result.args).toContain("--unshare-pid");
        expect(result.args).not.toContain("CAP_NET_BIND_SERVICE");
        expect(result.args.slice(-4)).toEqual(["--", "/bin/sh", "-lc", "git status --short"]);
    });

    it("keeps the temporary directory writable in Read only mode without exposing the workspace", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-read-only-temp-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const temporaryDirectory = join(root, "tmp");
        await Promise.all([mkdir(cwd), mkdir(temporaryDirectory)]);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "git status --short",
            commandCwd: cwd,
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
            temporaryDirectory,
        });

        expect(bindMode(result.args, await realpath(temporaryDirectory))).toBe("--bind");
        const canonicalCwd = await realpath(cwd);
        expect(bindMode(result.args, canonicalCwd)).toBe(
            isAtOrBelow(await realpath("/tmp"), canonicalCwd) ? "--ro-bind" : undefined,
        );
    });

    it("rebinds writable roots before protecting agent metadata and embedder-private control paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-workspace-write-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const temporaryDirectory = join(root, "tmp");
        const gitDirectory = join(cwd, ".git");
        const agentStateDirectory = join(cwd, ".agent-state");
        const agentCacheDirectory = join(cwd, ".agent-cache");
        const controlDirectory = join(temporaryDirectory, "agent-private");
        const tokenPath = join(controlDirectory, "token");
        await Promise.all([
            mkdir(join(gitDirectory, "info"), { recursive: true }),
            mkdir(agentStateDirectory, { recursive: true }),
            mkdir(agentCacheDirectory, { recursive: true }),
            mkdir(controlDirectory, { recursive: true }),
        ]);
        await writeFile(tokenPath, "secret\n");
        await writeFile(join(gitDirectory, "info", "exclude"), "*.local\n");
        const canonicalCwd = await realpath(cwd);
        const canonicalTemporaryDirectory = await realpath(temporaryDirectory);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            environment: { EMBEDDER_TOKEN_PATH: tokenPath },
            hostPolicy: {
                ...declaredHostPolicy,
                privateDirectories: [controlDirectory],
            },
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory,
        });

        expect(bindMode(result.args, canonicalCwd)).toBe("--bind");
        expect(bindMode(result.args, canonicalTemporaryDirectory)).toBe("--bind");
        expect(bindMode(result.args, gitDirectory)).not.toBe("--ro-bind");
        for (const protectedPath of [
            agentStateDirectory,
            agentCacheDirectory,
            controlDirectory,
            tokenPath,
        ]) {
            expect(bindMode(result.args, protectedPath)).toBe("--ro-bind");
            expect(lastBindIndex(result.args, protectedPath)).toBeGreaterThan(
                lastBindIndex(result.args, canonicalCwd),
            );
        }
        expect(result.projectConfigPlaceholders?.[0]?.gitExclude?.path).toBe(
            join(await realpath(gitDirectory), "info", "exclude"),
        );
        expect(
            mountIndex(
                result.args,
                "--ro-bind",
                result.projectConfigPlaceholders![0]!.gitExclude!.sourcePath,
                join(await realpath(gitDirectory), "info", "exclude"),
            ),
        ).toBeGreaterThan(lastBindIndex(result.args, canonicalCwd));
        await result.projectConfigPlaceholders?.[0]?.close();
        expect(result.args.slice(-6)).toEqual([
            "--chdir",
            canonicalCwd,
            "--",
            "/bin/sh",
            "-lc",
            "true",
        ]);
    });

    it("atomically masks an absent agent-policy.toml and monitors other absent protected paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-missing-protected-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        await mkdir(cwd);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        });
        const canonicalCwd = await realpath(cwd);

        for (const name of [".agent-state", ".agent-cache", ".git"]) {
            const path = join(cwd, name);
            expect(result.protectedCreatePaths).toContain(join(canonicalCwd, name));
            await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const projectConfigPath = join(canonicalCwd, "agent-policy.toml");
        expect(result.protectedCreatePaths).not.toContain(projectConfigPath);
        expect(result.protectedCreatePaths).toContain(join(canonicalCwd, "fallback-policy.toml"));
        expect(
            mountIndex(
                result.args,
                "--ro-bind",
                result.projectConfigPlaceholders![0]!.sourcePath,
                projectConfigPath,
            ),
        ).toBeGreaterThan(lastBindIndex(result.args, canonicalCwd));
        expect(result.projectConfigPlaceholders?.[0]?.path).toBe(projectConfigPath);
        await expect(access(projectConfigPath)).resolves.toBeUndefined();
        await expect(
            access(result.projectConfigPlaceholders![0]!.sourcePath),
        ).resolves.toBeUndefined();
        await result.projectConfigPlaceholders?.[0]?.close();
        await expect(access(projectConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps caller-level config masks alive across concurrent command startup", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-concurrent-config-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const gitExcludePath = join(cwd, ".git", "info", "exclude");
        await mkdir(join(cwd, ".git", "info"), { recursive: true });

        const command = {
            bwrapPath: "/usr/bin/bwrap",
            command: "git status --short",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write" as const,
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        };
        const [first, second] = await Promise.all([
            createLinuxBubblewrapCommand(command),
            createLinuxBubblewrapCommand(command),
        ]);
        const projectConfigPath = join(await realpath(cwd), "agent-policy.toml");

        expect(first.projectConfigPlaceholders).toBeDefined();
        expect(second.projectConfigPlaceholders).toBeDefined();
        expect(first.projectConfigPlaceholders![0]!.sourcePath).not.toBe(
            second.projectConfigPlaceholders![0]!.sourcePath,
        );
        expect(first.projectConfigPlaceholders![0]!.gitExclude?.sourcePath).not.toBe(
            second.projectConfigPlaceholders![0]!.gitExclude?.sourcePath,
        );
        await first.projectConfigPlaceholders![0]!.close();
        await expect(access(projectConfigPath)).resolves.toBeUndefined();
        await expect(access(gitExcludePath)).resolves.toBeUndefined();
        await second.projectConfigPlaceholders![0]!.close();
        await expect(access(projectConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(gitExcludePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a Git exclude symlink that escapes trusted repository metadata", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-exclude-symlink-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const outside = join(root, "outside-exclude");
        await mkdir(join(cwd, ".git", "info"), { recursive: true });
        await writeFile(outside, "*.local\n");
        await symlink(outside, join(cwd, ".git", "info", "exclude"));

        await expect(
            createLinuxBubblewrapCommand({
                bwrapPath: "/usr/bin/bwrap",
                command: "git status --short",
                commandCwd: cwd,
                cwd,
                mode: "workspace_write",
                shell: "/bin/sh",
                temporaryDirectory: join(root, "tmp"),
            }),
        ).rejects.toThrow("resolves outside its trusted metadata directory");
    });
    it("lets a denied write root beat an exact socket grant", async () => {
        // Bubblewrap masks the system temporary directory, so it cannot host this boundary fixture.
        const root = await mkdtemp(join(import.meta.dirname, ".bwrap-socket-grant-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const runtime = join(root, "runtime");
        await mkdir(cwd);
        await mkdir(runtime);
        const granted = join(runtime, "worklet.sock");
        const neighbour = join(runtime, "other.sock");
        await writeFile(granted, "");
        await writeFile(neighbour, "");

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write",
            deniedWritePaths: [runtime],
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
            unixSocketPaths: [granted],
        });

        expect(bindMode(result.args, granted)).toBeUndefined();
        expect(bindMode(result.args, runtime)).toBe("--ro-bind");
        expect(bindMode(result.args, neighbour)).toBeUndefined();
        expect(bindMode(result.args, "/")).toBe("--ro-bind");
    });

    it("does not add project metadata to an application-owned data directory", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-application-data-"));
        temporaryDirectories.push(cwd);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write",
            protectProjectMetadata: false,
            shell: "/bin/sh",
            temporaryDirectory: join(cwd, "tmp"),
        });

        expect(result.projectConfigPlaceholders).toBeUndefined();
        expect(bindMode(result.args, join(cwd, "agent-policy.toml"))).toBeUndefined();
        expect(result.protectedCreatePaths ?? []).not.toContain(join(cwd, ".git"));
    });

    it("adds no product-specific project protections when the host policy is empty", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-empty-policy-"));
        temporaryDirectories.push(cwd);
        const undeclared = join(cwd, "agent-policy.toml");
        await writeFile(undeclared, "ordinary data");

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            hostPolicy: {},
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(bindMode(result.args, undeclared)).not.toBe("--ro-bind");
        expect(result.projectConfigPlaceholders).toBeUndefined();
    });

    it("atomically masks every declared network policy file", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-policy-files-"));
        temporaryDirectories.push(cwd);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            hostPolicy: {
                networkPolicyFiles: ["network-primary.toml", "network-fallback.toml"],
            },
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(result.projectConfigPlaceholders?.map((placeholder) => placeholder.path)).toEqual([
            join(await realpath(cwd), "network-primary.toml"),
            join(await realpath(cwd), "network-fallback.toml"),
        ]);
    });

    it("ignores a granted socket that does not exist", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agent-compute-bwrap-socket-missing-"));
        temporaryDirectories.push(cwd);
        const missing = join(cwd, "never-created.sock");

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
            unixSocketPaths: [missing],
        });

        expect(result.args).not.toContain(missing);
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

function isAtOrBelow(root: string, target: string): boolean {
    const suffix = relative(root, target);
    return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
