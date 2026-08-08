import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { PROJECT_PROTECTED_FILE_NAMES } from "../../config/projectProtectedFileNames.js";
import type { PermissionMode } from "../../permissions/index.js";
import { findGitWritablePaths } from "./findGitWritablePaths.js";
import { MANAGED_NETWORK_SOCAT_PREFLIGHT } from "./managedNetworkSocatPreflight.js";
import {
    prepareProjectConfigPlaceholder,
    type ProjectConfigPlaceholder,
} from "./prepareProjectConfigPlaceholder.js";
import { quoteShellArgument } from "./quoteShellArgument.js";
import { resolvePotentialPath } from "./resolvePotentialPath.js";

const PROTECTED_WORKSPACE_NAMES = [".agents", ".codex", ...PROJECT_PROTECTED_FILE_NAMES] as const;
const PROTECTED_CREATE_ONLY_WORKSPACE_NAMES = [".git"] as const;

export async function createLinuxBubblewrapCommand(options: {
    /**
     * Run this exact argument vector instead of a shell command. Background readers use it so they
     * never build a shell string and never source the user's login profile.
     */
    argv?: readonly string[];
    additionalWritablePaths?: readonly string[];
    /**
     * Writable even when it sits inside a protected path, for a caller whose own folder is nested
     * under something it must not otherwise touch. Bound after the protections, so it re-opens
     * exactly these paths and nothing around them.
     */
    alwaysWritablePaths?: readonly string[];
    bwrapPath?: string;
    command: string;
    commandCwd: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    filesystemFullAccess?: boolean;
    mode: Exclude<PermissionMode, "full_access">;
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
    protectedPaths?: readonly string[];
    shell: string;
    temporaryDirectory?: string;
    uid?: number;
    unixSocketPaths?: readonly string[];
}): Promise<{
    args: readonly string[];
    command: string;
    projectConfigPlaceholder?: ProjectConfigPlaceholder;
    protectedCreatePaths?: readonly string[];
}> {
    const environment = options.environment ?? process.env;
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const privateTemporaryRoot = await resolvePotentialPath("/tmp");
    const canonicalCwd = await resolvePotentialPath(options.cwd);
    const protectProjectMetadata = options.protectProjectMetadata !== false;
    const projectConfigCandidates = protectProjectMetadata
        ? [join(options.cwd, "rig.toml"), await resolvePotentialPath(join(options.cwd, "rig.toml"))]
        : [];
    const projectConfigPath = join(canonicalCwd, "rig.toml");
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
            ? PROTECTED_WORKSPACE_NAMES.map((name) => join(options.cwd, name))
            : []),
        join(temporaryDirectory, `rig-${options.uid ?? process.getuid?.() ?? 0}`),
        environment.RIG_SERVER_DIRECTORY,
        environment.RIG_SERVER_SOCKET_PATH,
        environment.RIG_SERVER_TOKEN_PATH,
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
                  http: join("/dev/rig-network", basename(options.networkUnixProxySockets.http)),
                  loopback: options.networkUnixProxySockets.loopback?.map(({ path, port }) => ({
                      path: join("/dev/rig-network", basename(path)),
                      port,
                  })),
                  socks: join("/dev/rig-network", basename(options.networkUnixProxySockets.socks)),
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
    const projectConfigPlaceholder =
        protectProjectMetadata && options.mode !== "read_only"
            ? await prepareProjectConfigPlaceholder(projectConfigPath, gitExcludePath)
            : undefined;
    const protectedPaths = [
        ...allProtectedPaths.filter(
            (path) =>
                existsSync(path) &&
                (!isAtOrBelow(privateTemporaryRoot, path) ||
                    writableRoots.some((root) => isAtOrBelow(root, path))),
        ),
        ...(options.protectedPaths ?? []).filter(
            (path) => existsSync(path) && path !== privateTemporaryRoot,
        ),
    ];
    const neverGrantedSocketRoots = [environment.RIG_SERVER_DIRECTORY].filter(
        (path): path is string => typeof path === "string" && path.length > 0,
    );
    const neverGrantedSocketPaths = [
        environment.RIG_SERVER_SOCKET_PATH,
        environment.RIG_SERVER_TOKEN_PATH,
    ].filter((path): path is string => typeof path === "string" && path.length > 0);
    const grantedSocketPaths = [...new Set(options.unixSocketPaths ?? [])].filter(
        (path) =>
            existsSync(path) &&
            !neverGrantedSocketPaths.includes(path) &&
            !neverGrantedSocketRoots.some((root) => isAtOrBelow(root, path)),
    );
    const protectedCreatePaths = [...new Set(protectedCreateCandidates)].filter(
        (path) =>
            !existsSync(path) &&
            !projectConfigCandidates.includes(path) &&
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
        args.push("--dir", "/dev/rig-network", "--ro-bind", bridgeDirectory, "/dev/rig-network");
    }
    for (const writableRoot of writableRoots) args.push("--bind", writableRoot, writableRoot);
    for (const protectedPath of protectedPaths)
        args.push("--ro-bind", protectedPath, protectedPath);
    // The whole filesystem is bound read-only, and connecting to a Unix socket writes to the
    // socket itself, so an explicitly granted socket is bound writable by its exact path. This is
    // stated after broad protected roots to reopen the socket and nothing around it.
    for (const socketPath of grantedSocketPaths) args.push("--bind", socketPath, socketPath);
    // A caller's own folder, which may sit inside one of those protected paths. It is bound last
    // because it is the one thing the protection above is not meant to have taken away.
    if (options.mode !== "read_only") {
        for (const alwaysWritablePath of [...new Set(options.alwaysWritablePaths ?? [])].filter(
            (path) => existsSync(path),
        )) {
            args.push("--bind", alwaysWritablePath, alwaysWritablePath);
        }
    }
    if (projectConfigPlaceholder !== undefined) {
        if (projectConfigPlaceholder.gitExclude !== undefined) {
            args.push(
                "--ro-bind",
                projectConfigPlaceholder.gitExclude.sourcePath,
                projectConfigPlaceholder.gitExclude.path,
            );
        }
        args.push("--ro-bind", projectConfigPlaceholder.sourcePath, projectConfigPlaceholder.path);
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
        ...(projectConfigPlaceholder === undefined ? {} : { projectConfigPlaceholder }),
        ...(protectedCreatePaths.length === 0 ? {} : { protectedCreatePaths }),
    };
}

function authenticatedSocatCommand(port: number, socketPath: string, token: string): string {
    const relay = `{ printf %s "$RIG_NETWORK_TOKEN"; cat; } | ` + `socat - "$RIG_NETWORK_ADDRESS"`;
    return (
        `RIG_NETWORK_TOKEN=${quoteShellArgument(token)} ` +
        `RIG_NETWORK_ADDRESS=${quoteShellArgument(`UNIX-CONNECT:${socketPath}`)} ` +
        `socat TCP-LISTEN:${String(port)},bind=127.0.0.1,fork,reuseaddr ` +
        `SYSTEM:${quoteShellArgument(relay)} >/dev/null 2>&1 &`
    );
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
