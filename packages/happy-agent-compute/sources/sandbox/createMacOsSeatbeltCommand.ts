import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import type { ComputePermissionMode } from "../ComputePermissions.js";
import { createHostPolicyPrivatePaths } from "./impl/createHostPolicyPrivatePaths.js";
import { findGitWritablePaths } from "./impl/findGitWritablePaths.js";
import { MACOS_SEATBELT_BASE_POLICY } from "./impl/macOsSeatbeltBasePolicy.js";
import { projectProtectedFileNames } from "./impl/projectProtectedFileNames.js";
import { quoteShellArgument } from "./impl/quoteShellArgument.js";
import { resolvePotentialPath } from "./impl/resolvePotentialPath.js";

const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

export async function createMacOsSeatbeltCommand(options: {
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
    /** Whether the sandboxed process may create child processes. Defaults to true. */
    allowSubprocesses?: boolean;
    command: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    filesystemFullAccess?: boolean;
    homeDirectory?: string;
    hostPolicy?: ComputeHostPolicy;
    mode: ComputePermissionMode;
    networkAllowLocalBinding?: boolean;
    networkAllowedLoopbackPorts?: readonly number[];
    networkFullAccess?: boolean;
    path?: string;
    protectProjectMetadata?: boolean;
    deniedReadPaths?: readonly string[];
    deniedWritePaths?: readonly string[];
    shell: string;
    temporaryDirectory?: string;
    unixSocketPaths?: readonly string[];
}): Promise<{ args: readonly string[]; command: string }> {
    const environment = options.environment ?? process.env;
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const hostPolicy = options.hostPolicy ?? {};
    const privateCandidates = createHostPolicyPrivatePaths(hostPolicy, environment);
    const writableTemporaryPaths =
        options.temporaryDirectory === undefined
            ? [temporaryDirectory, "/tmp"]
            : [temporaryDirectory];
    // Read only withholds the workspace but still needs a writable temporary directory. Toolchain
    // shims such as macOS `xcrun` cache into TMPDIR on every invocation, and denying that write
    // makes them fall back to a path resolution that costs hundreds of milliseconds per command.
    const projectCandidates =
        options.mode === "read_only"
            ? []
            : [
                  options.cwd,
                  ...(options.protectProjectMetadata === false
                      ? []
                      : await findGitWritablePaths(options.cwd)),
              ];
    // Space the command's own declared permissions grant it, on top of its workspace. Read only
    // withholds the workspace, so it is never widened past it either.
    const grantedWritableCandidates =
        options.mode === "read_only"
            ? []
            : [
                  ...(options.additionalWritablePaths ?? []),
                  ...(options.filesystemFullAccess === true ? ["/"] : []),
              ];
    const writableCandidates =
        options.mode === "read_only"
            ? writableTemporaryPaths
            : [...projectCandidates, ...grantedWritableCandidates, ...writableTemporaryPaths];
    const writableRoots = [
        ...new Set(await Promise.all(writableCandidates.map(resolvePotentialPath))),
    ];
    // A unix socket is reachable by path, so where it may live decides what a command can talk to.
    // Inside a project a socket can only be one the command itself created; the host's own sockets —
    // the Docker daemon, the ssh agent, and embedder-private control sockets sit elsewhere and stay
    // unreachable, which is why this is narrower than writable space.
    //
    // The home folder is the exception that makes the rule worth stating: a session can run there,
    // and `~/.docker`, `~/.gnupg`, and password-manager agents keep their sockets under it, so
    // granting the home folder would hand over exactly what this scope exists to withhold. Any
    // ancestor of the home folder is refused for the same reason.
    const home = await resolvePotentialPath(options.homeDirectory ?? homedir());
    const projectSocketRoots = [
        ...new Set(await Promise.all(projectCandidates.map(resolvePotentialPath))),
    ].filter((root) => !isAtOrAbove(root, home));
    const protectedCandidates = [
        ...(options.protectProjectMetadata === false
            ? []
            : projectProtectedFileNames(hostPolicy).map((name) => join(options.cwd, name))),
        ...privateCandidates,
        ...(options.deniedWritePaths ?? []),
    ].filter((path): path is string => typeof path === "string" && path.length > 0);
    // Both spellings of every protected path. A deny rule matches the path the process actually
    // opens, and on macOS `/tmp` and `/var` are symlinks into `/private`, so withholding only the
    // name the caller declared would leave the very same folder writable under its resolved name.
    const protectedPaths = [
        ...new Set([
            ...protectedCandidates,
            ...(await Promise.all(protectedCandidates.map(resolvePotentialPath))),
        ]),
    ];
    const grantedSocketPaths = [
        ...new Set(await Promise.all((options.unixSocketPaths ?? []).map(resolvePotentialPath))),
    ].filter((path) => !protectedPaths.some((root) => isAtOrAbove(root, path)));
    const definitions: string[] = [];
    const deniedReadCandidates = [...privateCandidates, ...(options.deniedReadPaths ?? [])];
    const deniedReadPaths = [
        ...new Set([
            ...deniedReadCandidates,
            ...(await Promise.all(deniedReadCandidates.map(resolvePotentialPath))),
        ]),
    ];
    const deniedReadRules = deniedReadPaths.map((path, index) => {
        const key = `DENIED_READ_${String(index)}`;
        definitions.push(`-D${key}=${path}`);
        return `(deny file-read*
  (literal (param "${key}"))
  (subpath (param "${key}")))`;
    });
    const writableRules = writableRoots.map((root, index) => {
        const key = `WRITABLE_ROOT_${String(index)}`;
        definitions.push(`-D${key}=${root}`);
        return `  (subpath (param "${key}"))`;
    });
    const projectSocketRules = projectSocketRoots.flatMap((root, index) => {
        const key = `PROJECT_SOCKET_ROOT_${String(index)}`;
        definitions.push(`-D${key}=${root}`);
        return [
            `(allow network-bind (local unix-socket (subpath (param "${key}"))))`,
            `(allow network-outbound (remote unix-socket (subpath (param "${key}"))))`,
        ];
    });
    // One named socket the command may talk to, and nothing around it: connecting is allowed,
    // binding is not, and the grant is by literal path rather than by containing folder. This is
    // applied after broad protected-root denies, but only after paths under those roots have been
    // filtered out so a socket grant can never override a denial.
    const grantedSocketRules = grantedSocketPaths.flatMap((path, index) => {
        const key = `GRANTED_SOCKET_${String(index)}`;
        definitions.push(`-D${key}=${path}`);
        return [`(allow network-outbound (remote unix-socket (literal (param "${key}"))))`];
    });
    const protectedRules = protectedPaths.map((path, index) => {
        const key = `PROTECTED_WRITE_${String(index)}`;
        definitions.push(`-D${key}=${path}`);
        return `(deny file-write*
  (literal (param "${key}"))
  (subpath (param "${key}")))
(deny network-bind
  (local unix-socket (literal (param "${key}")))
  (local unix-socket (subpath (param "${key}"))))
(deny network-outbound
  (remote unix-socket (literal (param "${key}")))
  (remote unix-socket (subpath (param "${key}"))))`;
    });
    const fileWritePolicy =
        writableRules.length === 0 ? "" : `(allow file-write*\n${writableRules.join("\n")}\n)`;
    const alwaysWritableRoots =
        options.mode === "read_only"
            ? []
            : [
                  ...new Set(
                      (
                          await Promise.all(
                              (options.alwaysWritablePaths ?? []).map(resolvePotentialPath),
                          )
                      ).filter((path) => !protectedPaths.some((root) => isAtOrAbove(root, path))),
                  ),
              ];
    const alwaysWritableKeys = alwaysWritableRoots.map((root, index) => {
        const key = `ALWAYS_WRITABLE_ROOT_${String(index)}`;
        definitions.push(`-D${key}=${root}`);
        return key;
    });
    // These folders belong to the caller, so they are restored whole after protected roots have
    // been filtered out.
    const alwaysWritablePolicy =
        alwaysWritableKeys.length === 0
            ? ""
            : [
                  `(allow file-write*\n${alwaysWritableKeys
                      .map((key) => `  (subpath (param "${key}"))`)
                      .join("\n")}\n)`,
                  ...alwaysWritableKeys.map(
                      (key) =>
                          `(allow network-outbound (remote unix-socket (subpath (param "${key}"))))`,
                  ),
              ].join("\n");
    const policy = [
        MACOS_SEATBELT_BASE_POLICY,
        "; allow read-only file operations across the host",
        "(allow file-read*)",
        ...deniedReadRules,
        ...(options.networkAllowLocalBinding === true
            ? [
                  '(allow network-bind (local ip "*:*"))',
                  '(allow network-inbound (local ip "localhost:*"))',
                  "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))",
              ]
            : []),
        ...(options.networkAllowedLoopbackPorts ?? []).map(
            (port) => `(allow network-outbound (remote ip "localhost:${String(port)}"))`,
        ),
        // Unrestricted egress, including the lookups name resolution needs, for a command whose
        // own declared permissions ask for exactly that.
        //
        // Every rule here names `ip` deliberately. Unqualified network rules would also grant
        // every Unix socket on the host — the Docker daemon, the ssh agent, the password-manager
        // agents — which is exactly the reach the socket scoping above exists to withhold. Network
        // access and filesystem access stay separate grants, so asking for one never yields both.
        ...(options.networkFullAccess === true
            ? [
                  '(allow network-outbound (remote ip "*:*"))',
                  "(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6))",
                  `(allow mach-lookup
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.nehelper")
  (global-name "com.apple.nesessionmanager")
  (global-name "com.apple.networkd"))`,
              ]
            : []),
        ...(projectSocketRules.length === 0 && grantedSocketRules.length === 0
            ? []
            : ["(allow system-socket (socket-domain AF_UNIX))"]),
        ...projectSocketRules,
        fileWritePolicy,
        ...protectedRules,
        ...grantedSocketRules,
        ...(options.allowSubprocesses === false ? ["(deny process-fork)"] : []),
        // Caller-owned roots are stated last, after any root covered by a denial was filtered out.
        alwaysWritablePolicy,
    ]
        .filter((section) => section.length > 0)
        .join("\n");
    const userCommand =
        options.path === undefined
            ? options.command
            : `export PATH=${quoteShellArgument(options.path)}\n${options.command}`;

    return {
        args: [
            "-p",
            policy,
            ...definitions,
            "--",
            ...(options.argv ?? [options.shell, "-lc", userCommand]),
        ],
        command: MACOS_SEATBELT_EXECUTABLE,
    };
}

/** True when `candidate` is the path itself or one of its ancestors. */
function isAtOrAbove(candidate: string, path: string): boolean {
    if (candidate === path) return true;
    const prefix = candidate.endsWith(sep) ? candidate : `${candidate}${sep}`;
    return path.startsWith(prefix);
}
