import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import type { PermissionMode } from "../../permissions/index.js";
import { findGitWritablePaths } from "./findGitWritablePaths.js";
import { quoteShellArgument } from "./quoteShellArgument.js";
import { resolvePotentialPath } from "./resolvePotentialPath.js";

const PROTECTED_WORKSPACE_NAMES = [".agents", ".codex"] as const;

export async function createLinuxBubblewrapCommand(options: {
    /**
     * Run this exact argument vector instead of a shell command. Background readers use it so they
     * never build a shell string and never source the user's login profile.
     */
    argv?: readonly string[];
    bwrapPath?: string;
    command: string;
    commandCwd: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    mode: Exclude<PermissionMode, "full_access">;
    mountProc?: boolean;
    path?: string;
    shell: string;
    temporaryDirectory?: string;
    uid?: number;
}): Promise<{
    args: readonly string[];
    command: string;
    protectedCreatePaths?: readonly string[];
}> {
    const environment = options.environment ?? process.env;
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    // Read only withholds the workspace but still needs a writable temporary directory, matching
    // the Seatbelt policy and the sandbox-runtime filesystem config. Toolchain shims cache into
    // TMPDIR on every invocation, and denying that write costs hundreds of milliseconds per command.
    const writableCandidates =
        options.mode === "read_only"
            ? [temporaryDirectory, "/tmp"]
            : [
                  options.cwd,
                  ...(await findGitWritablePaths(options.cwd)),
                  temporaryDirectory,
                  "/tmp",
              ];
    const writableRoots = [
        ...new Set(await Promise.all(writableCandidates.map(resolvePotentialPath))),
    ].filter(existsSync);
    const protectedCandidates = [
        ...PROTECTED_WORKSPACE_NAMES.map((name) => join(options.cwd, name)),
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
    const protectedPaths = allProtectedPaths.filter(existsSync);
    const protectedCreatePaths = allProtectedPaths.filter(
        (path) =>
            !existsSync(path) &&
            writableRoots.some((root) => {
                const fromRoot = relative(root, path);
                return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
            }),
    );
    const commandCwd = await resolvePotentialPath(options.commandCwd);
    const userCommand =
        options.path === undefined
            ? options.command
            : `export PATH=${quoteShellArgument(options.path)}\n${options.command}`;
    const args = ["--new-session", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev"];

    for (const writableRoot of writableRoots) args.push("--bind", writableRoot, writableRoot);
    for (const protectedPath of protectedPaths)
        args.push("--ro-bind", protectedPath, protectedPath);

    args.push("--unshare-user", "--unshare-pid", "--unshare-net");
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
        ...(protectedCreatePaths.length === 0 ? {} : { protectedCreatePaths }),
    };
}
