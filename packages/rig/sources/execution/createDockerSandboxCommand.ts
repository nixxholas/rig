import type { PermissionMode } from "../permissions/index.js";
import type { PreparedDockerSandbox } from "./prepareDockerSandbox.js";

export function createDockerSandboxCommand(options: {
    command: string;
    commandCwd: string;
    mode: Exclude<PermissionMode, "full_access">;
    networkUnixProxySockets?: {
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
    protectedPaths?: readonly string[];
    runtime: PreparedDockerSandbox;
    shell: string;
    workspaceCwd: string;
}): string[] {
    const command = [
        options.runtime.bwrapPath,
        "--new-session",
        "--die-with-parent",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
    ];
    if (options.mode !== "read_only") {
        command.push("--bind", "/tmp", "/tmp");
        command.push("--bind", options.workspaceCwd, options.workspaceCwd);
    }
    for (const name of [".agents", ".codex", "rig.toml"])
        command.push(
            "--ro-bind-try",
            `${options.workspaceCwd}/${name}`,
            `${options.workspaceCwd}/${name}`,
        );
    for (const path of options.protectedPaths ?? []) command.push("--ro-bind", path, path);
    const userCommand =
        options.networkUnixProxySockets === undefined
            ? options.command
            : [
                  `socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(options.networkUnixProxySockets.http)} >/dev/null 2>&1 &`,
                  `socat TCP-LISTEN:1080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(options.networkUnixProxySockets.socks)} >/dev/null 2>&1 &`,
                  ...(options.networkUnixProxySockets.loopback ?? []).map(
                      ({ path, port }) =>
                          `socat TCP-LISTEN:${String(port)},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${shellQuote(path)} >/dev/null 2>&1 &`,
                  ),
                  `trap 'kill $(jobs -p) 2>/dev/null || true' EXIT`,
                  readinessCheck([
                      3128,
                      1080,
                      ...(options.networkUnixProxySockets.loopback ?? []).map(({ port }) => port),
                  ]),
                  options.command,
              ].join("\n");
    command.push(
        "--unshare-pid",
        "--unshare-user",
        "--bind",
        "/proc",
        "/proc",
        "--chdir",
        options.commandCwd,
        "--",
        options.shell,
        "-lc",
        userCommand,
    );
    return command;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readinessCheck(ports: readonly number[]): string {
    return ports
        .map(
            (port) =>
                `attempt=0; until socat -u /dev/null TCP4:127.0.0.1:${String(port)} >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 100 ] || { echo "Managed network bridge did not become ready." >&2; exit 1; }; sleep 0.01; done`,
        )
        .join("\n");
}
