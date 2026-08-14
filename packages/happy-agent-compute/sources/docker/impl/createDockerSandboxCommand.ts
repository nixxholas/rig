import { posix } from "node:path";

import type { ComputePermissionMode } from "../../ComputePermissions.js";
import { MANAGED_NETWORK_SOCAT_PREFLIGHT } from "../../network/impl/managedNetworkSocatPreflight.js";
import type { PreparedDockerSandbox } from "./prepareDockerSandbox.js";

/**
 * Builds the Bubblewrap command line that wraps one restricted command inside the container.
 *
 * The wrapper reproduces the sandbox master plan's container contract: a fresh session that unshares
 * the network, PID, user, and mount namespaces; a read-only view of the whole filesystem with only
 * the workspace made writable; a private `/tmp`; and a private `/proc` over tmpfs when nested procfs
 * mounting is unavailable. Read-only mode makes the workspace itself read-only. Project config files
 * and Git metadata are bound read-only so a restricted command cannot rewrite the policy the next
 * command trusts. When a managed network is present, the user command is prefixed with a relay
 * script that carries allowed egress over the bridge sockets rather than opening the container's own
 * network.
 */
export function createDockerSandboxCommand(options: {
    command: string;
    commandCwd: string;
    deniedReadPaths?: readonly { kind: "directory" | "file"; path: string }[];
    isolateNetwork?: boolean;
    mode: ComputePermissionMode;
    networkBridgeRoot?: string;
    networkUnixProxySockets?: {
        authenticationToken: string;
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
    protectedPaths?: readonly string[];
    protectedProjectFiles?: readonly string[];
    readablePaths?: readonly string[];
    readyNetworkPolicyFiles?: readonly string[];
    runtime: PreparedDockerSandbox;
    shell: string;
    writablePaths?: readonly string[];
    workspaceCwd: string;
}): string[] {
    validateNetworkBridgePaths(options);
    const command = [
        options.runtime.bwrapPath,
        "--new-session",
        "--die-with-parent",
        options.mode === "full_access" ? "--bind" : "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ];
    if (options.isolateNetwork !== false) command.push("--unshare-net");
    if (options.mode === "read_only") {
        if (isAtOrBelow("/tmp", options.workspaceCwd)) {
            command.push("--ro-bind", options.workspaceCwd, options.workspaceCwd);
        }
    } else if (options.mode === "full_access" && isAtOrBelow("/tmp", options.workspaceCwd)) {
        command.push("--bind", options.workspaceCwd, options.workspaceCwd);
    } else if (options.mode !== "full_access") {
        command.push("--bind", options.workspaceCwd, options.workspaceCwd);
    }
    if (options.mode !== "read_only") {
        for (const writablePath of options.writablePaths ?? []) {
            command.push("--bind-try", writablePath, writablePath);
        }
    }
    if (options.mode !== "full_access") {
        for (const readablePath of options.readablePaths ?? []) {
            command.push("--ro-bind-try", readablePath, readablePath);
        }
    }
    if (options.networkBridgeRoot !== undefined) {
        command.push("--ro-bind", options.networkBridgeRoot, options.networkBridgeRoot);
    }
    if (options.mode !== "full_access") {
        for (const name of options.protectedProjectFiles ?? []) {
            const projectConfigPath = `${options.workspaceCwd}/${name}`;
            const hasPreparedProjectConfig =
                options.readyNetworkPolicyFiles?.includes(name) === true;
            command.push(
                hasPreparedProjectConfig ? "--ro-bind" : "--ro-bind-try",
                projectConfigPath,
                projectConfigPath,
            );
        }
    }
    for (const protectedPath of options.protectedPaths ?? []) {
        command.push("--ro-bind-try", protectedPath, protectedPath);
    }
    for (const deniedPath of options.deniedReadPaths ?? []) {
        if (deniedPath.kind === "directory") {
            command.push("--tmpfs", deniedPath.path, "--remount-ro", deniedPath.path);
        } else {
            command.push("--ro-bind", "/dev/null", deniedPath.path);
        }
    }
    const userCommand =
        options.networkUnixProxySockets === undefined
            ? options.command
            : createDockerNetworkRelayScript(options.command, options.networkUnixProxySockets);
    command.push(
        "--unshare-pid",
        "--unshare-user",
        "--tmpfs",
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

/**
 * Wraps a command with the socat relays that carry its allowed egress over the bridge sockets.
 *
 * Each relay listens on the loopback port the command expects and forwards to a Unix socket the
 * host bridge serves, presenting an unguessable command-scoped token first so a neighbouring
 * command cannot borrow the connection. The relays are torn down when the command exits, and the
 * command only starts once every relay reports ready.
 */
export function createDockerNetworkRelayScript(
    command: string,
    sockets: NonNullable<
        Parameters<typeof createDockerSandboxCommand>[0]["networkUnixProxySockets"]
    >,
    options: { includeProxyPorts?: boolean } = {},
): string {
    const proxyPorts = options.includeProxyPorts === false ? [] : [3128, 1080];
    return [
        MANAGED_NETWORK_SOCAT_PREFLIGHT,
        `COMPUTE_INTERNAL_NETWORK_RELAY_PIDS=''`,
        ...(options.includeProxyPorts === false
            ? []
            : [
                  authenticatedSocatCommand(3128, sockets.http, sockets.authenticationToken),
                  authenticatedSocatCommand(1080, sockets.socks, sockets.authenticationToken),
              ]),
        ...(sockets.loopback ?? []).map(({ path, port }) =>
            authenticatedSocatCommand(port, path, sockets.authenticationToken),
        ),
        `readonly COMPUTE_INTERNAL_NETWORK_RELAY_PIDS`,
        `trap 'kill $COMPUTE_INTERNAL_NETWORK_RELAY_PIDS 2>/dev/null || true' EXIT`,
        readinessCheck([...proxyPorts, ...(sockets.loopback ?? []).map(({ port }) => port)]),
        command,
    ].join("\n");
}

function authenticatedSocatCommand(port: number, socketPath: string, token: string): string {
    const relay =
        `{ printf %s "$COMPUTE_NETWORK_TOKEN"; cat; } | ` + `socat - "$COMPUTE_NETWORK_ADDRESS"`;
    return (
        `COMPUTE_NETWORK_TOKEN=${shellQuote(token)} ` +
        `COMPUTE_NETWORK_ADDRESS=${shellQuote(`UNIX-CONNECT:${socketPath}`)} ` +
        `socat TCP-LISTEN:${String(port)},bind=127.0.0.1,fork,reuseaddr ` +
        `SYSTEM:${shellQuote(relay)} >/dev/null 2>&1 &\n` +
        `COMPUTE_INTERNAL_NETWORK_RELAY_PIDS="$COMPUTE_INTERNAL_NETWORK_RELAY_PIDS $!"`
    );
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readinessCheck(ports: readonly number[]): string {
    return ports
        .map(
            (port) =>
                `attempt=0; until socat -T 0.1 -u /dev/null TCP4:127.0.0.1:${String(port)} >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 100 ] || { echo "Managed network bridge did not become ready." >&2; exit 1; }; sleep 0.01; done`,
        )
        .join("\n");
}

function validateNetworkBridgePaths(options: {
    networkBridgeRoot?: string;
    networkUnixProxySockets?: {
        http: string;
        loopback?: readonly { path: string }[];
        socks: string;
    };
    workspaceCwd: string;
}): void {
    if (
        options.networkBridgeRoot !== undefined &&
        !isAtOrBelow(options.workspaceCwd, options.networkBridgeRoot)
    ) {
        throw new Error("Docker managed network bridge root must be inside the workspace.");
    }
    if (options.networkUnixProxySockets === undefined) return;
    if (options.networkBridgeRoot === undefined) {
        throw new Error("Docker managed network sockets require a protected bridge root.");
    }
    const paths = [
        options.networkUnixProxySockets.http,
        options.networkUnixProxySockets.socks,
        ...(options.networkUnixProxySockets.loopback ?? []).map(({ path }) => path),
    ];
    if (paths.some((path) => !isAtOrBelow(options.networkBridgeRoot!, path))) {
        throw new Error("Docker managed network sockets must be inside the protected bridge root.");
    }
}

function isAtOrBelow(root: string, target: string): boolean {
    const suffix = posix.relative(root, target);
    return (
        suffix === "" || (!suffix.startsWith("../") && suffix !== ".." && !posix.isAbsolute(suffix))
    );
}
