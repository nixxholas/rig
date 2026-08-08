import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSandboxFilesystemConfig } from "./createSandboxFilesystemConfig.js";
import { createSandboxConfigDirectoryCache } from "./createSandboxConfigDirectoryCache.js";
import { createLinuxBubblewrapCommand } from "./createLinuxBubblewrapCommand.js";
import { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";
import { materializeSandboxConfig } from "./materializeSandboxConfig.js";
import type { PermissionMode } from "../../permissions/index.js";
import { quoteShellArgument } from "./quoteShellArgument.js";
import type { ProjectConfigPlaceholder } from "./prepareProjectConfigPlaceholder.js";

const require = createRequire(import.meta.url);
const getConfigDirectory = createSandboxConfigDirectoryCache(() =>
    mkdtemp(join(tmpdir(), "rig-sandbox-")),
);

export interface SandboxedCommand {
    args?: readonly string[];
    command: string;
    projectConfigPlaceholder?: ProjectConfigPlaceholder;
    protectedCreatePaths?: readonly string[];
}

export async function createSandboxedCommand(options: {
    /**
     * Run this exact argument vector instead of a shell command. Background readers use it so they
     * never build a shell string and never source the user's login profile.
     */
    argv?: readonly string[];
    /**
     * Writable space this command is granted beyond its workspace, and the whole filesystem when
     * `filesystemFullAccess` is set. Read only ignores both, because a mode that withholds the
     * workspace cannot be talked into handing over more than it.
     */
    additionalWritablePaths?: readonly string[];
    /**
     * Writable even when it sits inside a protected path, for a caller whose own folder is nested
     * under something it must not otherwise touch.
     */
    alwaysWritablePaths?: readonly string[];
    /** Whether the sandboxed process may create child processes. Defaults to true. */
    allowSubprocesses?: boolean;
    command: string;
    commandCwd?: string;
    cwd: string;
    filesystemFullAccess?: boolean;
    mode: PermissionMode;
    networkAllowLocalBinding?: boolean;
    networkAllowedLoopbackPorts?: readonly number[];
    /** Unrestricted egress, for a command whose declared permissions ask for exactly that. */
    networkFullAccess?: boolean;
    networkUnixProxySockets?: {
        authenticationToken: string;
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
    path?: string;
    protectedPaths?: readonly string[];
    shell: string;
    /** Writable temporary directory visible to this process instead of the host's shared one. */
    temporaryDirectory?: string;
    /**
     * Exact Unix sockets this command may connect to, whatever its writable space is.
     *
     * A sandboxed command can otherwise only reach a socket it created inside its own workspace.
     * This grants one named socket outside that scope — a worklet reaching Rig's own private API —
     * without widening what the command may read or write anywhere else.
     */
    unixSocketPaths?: readonly string[];
}): Promise<SandboxedCommand> {
    if (options.mode === "full_access") {
        return options.argv === undefined
            ? { command: options.command }
            : { args: options.argv.slice(1), command: options.argv[0]! };
    }
    if (process.platform === "darwin") return createMacOsSeatbeltCommand(options);
    if (process.platform === "linux") {
        return createLinuxBubblewrapCommand({
            ...options,
            commandCwd: options.commandCwd ?? options.cwd,
            mode: options.mode,
            mountProc: !(
                process.env.RIG_GYM_OUTER_ISOLATION === "docker" && existsSync("/.dockerenv")
            ),
        });
    }

    const configDirectory = await getConfigDirectory();
    const config = {
        // Gym's disposable Docker container is the outer isolation layer for nested sandbox tests.
        enableWeakerNestedSandbox:
            process.env.RIG_GYM_OUTER_ISOLATION === "docker" && existsSync("/.dockerenv"),
        network: {
            allowedDomains: options.networkFullAccess === true ? ["*"] : [],
            deniedDomains: [],
        },
        filesystem: await createSandboxFilesystemConfig({
            ...options,
            sandboxConfigDirectory: configDirectory,
        }),
    };
    const configPath = await materializeSandboxConfig(configDirectory, config);

    const packageEntry = require.resolve("@anthropic-ai/sandbox-runtime");
    const cliPath = join(dirname(packageEntry), "cli.js");
    // The sandbox-runtime CLI only accepts a command string, so an argument vector is rebuilt into
    // one with each element quoted individually rather than concatenated by a caller.
    const requestedCommand =
        options.argv === undefined
            ? options.command
            : options.argv.map((argument) => quoteShellArgument(argument)).join(" ");
    const userCommand =
        options.path === undefined
            ? requestedCommand
            : `export PATH=${quoteShellArgument(options.path)}\n${requestedCommand}`;
    const command =
        process.platform === "win32"
            ? requestedCommand
            : `${quoteShellArgument(options.shell)} -lc ${quoteShellArgument(userCommand)}`;
    return {
        args: [cliPath, "--settings", configPath, "-c", command],
        command: process.execPath,
    };
}
