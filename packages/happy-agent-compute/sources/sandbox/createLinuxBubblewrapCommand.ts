import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import type { ComputePermissionMode } from "../ComputePermissions.js";
import { createHostPolicyPrivatePaths } from "./impl/createHostPolicyPrivatePaths.js";
import { findGitWritablePaths } from "./impl/findGitWritablePaths.js";
import { MANAGED_NETWORK_SOCAT_PREFLIGHT } from "../network/impl/managedNetworkSocatPreflight.js";
import {
    prepareProjectConfigPlaceholder,
    type ProjectConfigPlaceholder,
} from "./prepareProjectConfigPlaceholder.js";
import {
    projectNetworkPolicyFileNames,
    projectProtectedFileNames,
} from "./impl/projectProtectedFileNames.js";
import { quoteShellArgument } from "./impl/quoteShellArgument.js";
import { resolvePotentialPath } from "./impl/resolvePotentialPath.js";

const PROTECTED_CREATE_ONLY_WORKSPACE_NAMES = [".git"] as const;
const SANDBOX_NETWORK_DIRECTORY = "/dev/agent-compute-network";

export async function createLinuxBubblewrapCommand(options: {
    /**
     * Run this exact argument vector instead of a shell command. Background readers use it so they
     * never build a shell string and never source the user's login profile.
     */
    argv?: readonly string[];
    additionalReadablePaths?: readonly string[];
    additionalWritablePaths?: readonly string[];
    /**
     * Caller-owned writable roots beyond the command workspace. Declared denials still win.
     */
    alwaysWritablePaths?: readonly string[];
    bwrapPath?: string;
    command: string;
    commandCwd: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    filesystemFullAccess?: boolean;
    hostPolicy?: ComputeHostPolicy;
    mode: Exclude<ComputePermissionMode, "full_access">;
    mountProc?: boolean;
    networkFullAccess?: boolean;
    networkUnixProxySockets?: {
        authenticationToken: string;
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
    path?: string;
    protectProjectMetadata?: boolean;
    deniedReadPaths?: readonly string[];
    deniedWritePaths?: readonly string[];
    shell: string;
    temporaryDirectory?: string;
    unixSocketPaths?: readonly string[];
}): Promise<{
    args: readonly string[];
    command: string;
    projectConfigPlaceholders?: readonly ProjectConfigPlaceholder[];
    protectedCreatePaths?: readonly string[];
}> {
    const environment = options.environment ?? process.env;
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const hostPolicy = options.hostPolicy ?? {};
    const privateCandidates = createHostPolicyPrivatePaths(hostPolicy, environment);
    const privateTemporaryRoot = await resolvePotentialPath("/tmp");
    const canonicalCwd = await resolvePotentialPath(options.cwd);
    const protectProjectMetadata = options.protectProjectMetadata !== false;
    const networkPolicyFileNames = protectProjectMetadata
        ? projectNetworkPolicyFileNames(hostPolicy)
        : [];
    const networkPolicyCandidates = [
        ...new Set(
            (
                await Promise.all(
                    networkPolicyFileNames.flatMap((name) => {
                        const path = join(options.cwd, name);
                        return [path, resolvePotentialPath(path)];
                    }),
                )
            ).flat(),
        ),
    ];
    const networkPolicyPaths = networkPolicyFileNames.map((name) => join(canonicalCwd, name));
    const gitWritablePaths =
        options.mode === "read_only" || !protectProjectMetadata
            ? []
            : await findGitWritablePaths(options.cwd);
    const gitMetadataRoot = gitWritablePaths.at(-1);
    const gitExcludePath =
        gitMetadataRoot === undefined
            ? undefined
            : await resolvePotentialPath(join(gitMetadataRoot, "info", "exclude"));
    if (
        gitMetadataRoot !== undefined &&
        gitExcludePath !== undefined &&
        !isAtOrBelow(gitMetadataRoot, gitExcludePath)
    ) {
        throw new Error(
            "The repository's Git exclude path resolves outside its trusted metadata directory.",
        );
    }
    // Read only withholds the workspace but still needs a writable temporary directory, matching
    // the Seatbelt policy and the sandbox-runtime filesystem config. Toolchain shims cache into
    // TMPDIR on every invocation, and denying that write costs hundreds of milliseconds per command.
    // Space the command's own declared permissions grant it, on top of its workspace. Read only
    // withholds the workspace, so it is never widened past it either.
    const filesystemFullAccess =
        options.mode !== "read_only" && options.filesystemFullAccess === true;
    const writableCandidates =
        options.mode === "read_only"
            ? [temporaryDirectory]
            : [
                  canonicalCwd,
                  ...gitWritablePaths,
                  ...(options.additionalWritablePaths ?? []),
                  temporaryDirectory,
              ];
    const writableRoots = [
        ...new Set(await Promise.all(writableCandidates.map(resolvePotentialPath))),
    ].filter((path) => existsSync(path) && path !== privateTemporaryRoot);
    const protectedCandidates = [
        ...(protectProjectMetadata
            ? projectProtectedFileNames(hostPolicy).map((name) => join(options.cwd, name))
            : []),
        ...privateCandidates,
        ...(options.deniedWritePaths ?? []),
    ].filter((path): path is string => typeof path === "string" && path.length > 0);
    const allProtectedPaths = [
        ...new Set([
            ...protectedCandidates,
            ...(await Promise.all(protectedCandidates.map(resolvePotentialPath))),
        ]),
    ];
    const protectedCreateCandidates = [
        ...allProtectedPaths,
        ...(await Promise.all(
            (protectProjectMetadata ? PROTECTED_CREATE_ONLY_WORKSPACE_NAMES : []).flatMap(
                (name) => {
                    const path = join(options.cwd, name);
                    return [path, resolvePotentialPath(path)];
                },
            ),
        )),
    ];
    const commandCwd = await resolvePotentialPath(options.commandCwd);
    const bridgeDirectory =
        options.networkUnixProxySockets === undefined
            ? undefined
            : dirname(options.networkUnixProxySockets.http);
    if (
        bridgeDirectory !== undefined &&
        [
            options.networkUnixProxySockets!.socks,
            ...(options.networkUnixProxySockets!.loopback ?? []).map(({ path }) => path),
        ].some((path) => dirname(path) !== bridgeDirectory)
    ) {
        throw new Error("Managed network bridge sockets must share one directory.");
    }
    const requestedCommand =
        options.path === undefined
            ? options.command
            : `export PATH=${quoteShellArgument(options.path)}\n${options.command}`;
    const sandboxNetworkSockets =
        options.networkUnixProxySockets === undefined
            ? undefined
            : {
                  ...options.networkUnixProxySockets,
                  http: join(
                      SANDBOX_NETWORK_DIRECTORY,
                      basename(options.networkUnixProxySockets.http),
                  ),
                  loopback: options.networkUnixProxySockets.loopback?.map(({ path, port }) => ({
                      path: join(SANDBOX_NETWORK_DIRECTORY, basename(path)),
                      port,
                  })),
                  socks: join(
                      SANDBOX_NETWORK_DIRECTORY,
                      basename(options.networkUnixProxySockets.socks),
                  ),
              };
    const userCommand =
        sandboxNetworkSockets === undefined
            ? requestedCommand
            : [
                  MANAGED_NETWORK_SOCAT_PREFLIGHT,
                  authenticatedSocatCommand(
                      3128,
                      sandboxNetworkSockets.http,
                      sandboxNetworkSockets.authenticationToken,
                  ),
                  authenticatedSocatCommand(
                      1080,
                      sandboxNetworkSockets.socks,
                      sandboxNetworkSockets.authenticationToken,
                  ),
                  ...(sandboxNetworkSockets.loopback ?? []).map(({ path, port }) =>
                      authenticatedSocatCommand(
                          port,
                          path,
                          sandboxNetworkSockets.authenticationToken,
                      ),
                  ),
                  `trap 'kill $(jobs -p) 2>/dev/null || true' EXIT`,
                  readinessCheck([
                      3128,
                      1080,
                      ...(sandboxNetworkSockets.loopback ?? []).map(({ port }) => port),
                  ]),
                  requestedCommand,
              ].join("\n");
    const projectConfigPlaceholders =
        protectProjectMetadata && options.mode !== "read_only"
            ? await prepareProjectPolicyPlaceholders(
                  networkPolicyPaths,
                  gitExcludePath,
                  networkPolicyFileNames,
              )
            : [];
    const protectedPaths = allProtectedPaths.filter(
        (path) =>
            existsSync(path) &&
            (!isAtOrBelow(privateTemporaryRoot, path) ||
                writableRoots.some((root) => isAtOrBelow(root, path))),
    );
    const grantedSocketPaths = [...new Set(options.unixSocketPaths ?? [])].filter(
        (path) => existsSync(path) && !allProtectedPaths.some((root) => isAtOrBelow(root, path)),
    );
    const protectedCreatePaths = [...new Set(protectedCreateCandidates)].filter(
        (path) =>
            !existsSync(path) &&
            !networkPolicyCandidates.includes(path) &&
            writableRoots.some((root) => {
                const fromRoot = relative(root, path);
                return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
            }),
    );
    // Full disk access is the root bind itself rather than a later one, because rebinding `/` on
    // top of the sandbox would discard the `/dev` and `/tmp` mounts set up right after it.
    const args = [
        "--new-session",
        "--die-with-parent",
        filesystemFullAccess ? "--bind" : "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ];
    if (options.mode === "read_only" && isAtOrBelow(privateTemporaryRoot, canonicalCwd)) {
        args.push("--ro-bind", canonicalCwd, canonicalCwd);
    }

    if (bridgeDirectory !== undefined) {
        args.push(
            "--dir",
            SANDBOX_NETWORK_DIRECTORY,
            "--ro-bind",
            bridgeDirectory,
            SANDBOX_NETWORK_DIRECTORY,
        );
    }
    for (const writableRoot of writableRoots) args.push("--bind", writableRoot, writableRoot);
    for (const protectedPath of protectedPaths)
        args.push("--ro-bind", protectedPath, protectedPath);
    // The whole filesystem is bound read-only, and connecting to a Unix socket writes to the
    // socket itself, so an explicitly granted socket is bound writable by its exact path. This is
    // stated after the read-only filesystem bind to reopen the socket and nothing around it.
    for (const socketPath of grantedSocketPaths) args.push("--bind", socketPath, socketPath);
    // Caller-owned roots are bound last, after any root covered by a denial was filtered out.
    if (options.mode !== "read_only") {
        for (const alwaysWritablePath of [...new Set(options.alwaysWritablePaths ?? [])].filter(
            (path) =>
                existsSync(path) && !allProtectedPaths.some((root) => isAtOrBelow(root, path)),
        )) {
            args.push("--bind", alwaysWritablePath, alwaysWritablePath);
        }
    }
    for (const projectConfigPlaceholder of projectConfigPlaceholders) {
        if (projectConfigPlaceholder.gitExclude !== undefined) {
            args.push(
                "--ro-bind",
                projectConfigPlaceholder.gitExclude.sourcePath,
                projectConfigPlaceholder.gitExclude.path,
            );
        }
        args.push("--ro-bind", projectConfigPlaceholder.sourcePath, projectConfigPlaceholder.path);
    }
    // Read denials are mounted last so they win over the workspace, caller grants, and the
    // protected project placeholder alike. Existing data is hidden rather than copied anywhere
    // the command can inspect.
    const deniedReadPaths = [
        ...new Set(
            (
                await Promise.all(
                    [...privateCandidates, ...(options.deniedReadPaths ?? [])].flatMap((path) => [
                        path,
                        resolvePotentialPath(path),
                    ]),
                )
            ).filter((path) => existsSync(path)),
        ),
    ];
    for (const deniedReadPath of deniedReadPaths) {
        if (lstatSync(deniedReadPath).isDirectory()) {
            args.push("--tmpfs", deniedReadPath, "--remount-ro", deniedReadPath);
        } else {
            args.push("--ro-bind", "/dev/null", deniedReadPath);
        }
    }

    // The network namespace is the whole of the egress policy here: keeping it isolated is what
    // makes the bridge the only way out, and sharing it is what unrestricted egress means.
    args.push("--unshare-user", "--unshare-pid");
    if (options.networkFullAccess !== true) args.push("--unshare-net");
    args.push(options.mountProc === false ? "--bind" : "--proc", "/proc");
    if (options.mountProc === false) args.push("/proc");
    args.push("--chdir", commandCwd, "--");
    if (options.argv === undefined) {
        args.push(options.shell, "-lc", userCommand);
    } else {
        args.push(...options.argv);
    }

    return {
        args,
        command: options.bwrapPath ?? "bwrap",
        ...(projectConfigPlaceholders.length === 0 ? {} : { projectConfigPlaceholders }),
        ...(protectedCreatePaths.length === 0 ? {} : { protectedCreatePaths }),
    };
}

function authenticatedSocatCommand(port: number, socketPath: string, token: string): string {
    const relay =
        `{ printf %s "$AGENT_COMPUTE_NETWORK_TOKEN"; cat; } | ` +
        `socat - "$AGENT_COMPUTE_NETWORK_ADDRESS"`;
    return (
        `AGENT_COMPUTE_NETWORK_TOKEN=${quoteShellArgument(token)} ` +
        `AGENT_COMPUTE_NETWORK_ADDRESS=${quoteShellArgument(`UNIX-CONNECT:${socketPath}`)} ` +
        `socat TCP-LISTEN:${String(port)},bind=127.0.0.1,fork,reuseaddr ` +
        `SYSTEM:${quoteShellArgument(relay)} >/dev/null 2>&1 &`
    );
}

async function prepareProjectPolicyPlaceholders(
    paths: readonly string[],
    gitExcludePath: string | undefined,
    gitExcludeEntries: readonly string[],
): Promise<readonly ProjectConfigPlaceholder[]> {
    const placeholders: ProjectConfigPlaceholder[] = [];
    try {
        for (const path of paths) {
            const placeholder = await prepareProjectConfigPlaceholder(
                path,
                gitExcludePath,
                gitExcludeEntries,
            );
            if (placeholder !== undefined) placeholders.push(placeholder);
        }
        return placeholders;
    } catch (error) {
        const cleanup = await Promise.allSettled(
            placeholders.map((placeholder) => placeholder.close()),
        );
        const cleanupErrors = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        throw cleanupErrors.length === 0
            ? error
            : new AggregateError(
                  [error, ...cleanupErrors],
                  "Could not clean up project policy placeholders after setup failed.",
              );
    }
}

function readinessCheck(ports: readonly number[]): string {
    return ports
        .map(
            (port) =>
                `attempt=0; until socat -T 0.1 -u /dev/null TCP4:127.0.0.1:${String(port)} >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 100 ] || { echo "Managed network bridge did not become ready." >&2; exit 1; }; sleep 0.01; done`,
        )
        .join("\n");
}

function isAtOrBelow(root: string, path: string): boolean {
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}
