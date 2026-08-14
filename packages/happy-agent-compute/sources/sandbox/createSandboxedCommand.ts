import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import type { ComputePermissionMode } from "../ComputePermissions.js";
import { createSandboxFilesystemConfig } from "./createSandboxFilesystemConfig.js";
import { createSandboxConfigDirectoryCache } from "./impl/createSandboxConfigDirectoryCache.js";
import { createHostPolicyPrivatePaths } from "./impl/createHostPolicyPrivatePaths.js";
import { createLinuxBubblewrapCommand } from "./createLinuxBubblewrapCommand.js";
import { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";
import { materializeSandboxConfig } from "./impl/materializeSandboxConfig.js";
import { quoteShellArgument } from "./impl/quoteShellArgument.js";
import type { ProjectConfigPlaceholder } from "./prepareProjectConfigPlaceholder.js";

const require = createRequire(import.meta.url);
const getConfigDirectory = createSandboxConfigDirectoryCache(() =>
    mkdtemp(join(tmpdir(), "agent-compute-sandbox-")),
);

export interface SandboxedCommand {
    args?: readonly string[];
    command: string;
    projectConfigPlaceholders?: readonly ProjectConfigPlaceholder[];
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
    additionalReadablePaths?: readonly string[];
    additionalWritablePaths?: readonly string[];
    /**
     * Caller-owned writable roots beyond the command workspace. Declared denials still win.
     */
    alwaysWritablePaths?: readonly string[];
    /** Whether the sandboxed process may create child processes. Defaults to true. */
    allowSubprocesses?: boolean;
    command: string;
    commandCwd?: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    filesystemFullAccess?: boolean;
    hostPolicy?: ComputeHostPolicy;
    /** Home directory used to identify universal private credential paths. */
    homeDirectory?: string;
    mode: ComputePermissionMode;
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
    /**
     * Protects project configuration and metadata inside `cwd`. Defaults to true. Callers whose
     * working directory is application-owned data rather than a project may disable it.
     */
    protectProjectMetadata?: boolean;
    deniedReadPaths?: readonly string[];
    deniedWritePaths?: readonly string[];
    shell: string;
    /** Writable temporary directory visible to this process instead of the host's shared one. */
    temporaryDirectory?: string;
    /**
     * Exact Unix sockets this command may connect to, whatever its writable space is.
     *
     * A sandboxed command can otherwise only reach a socket it created inside its own workspace.
     * This grants one named socket outside that scope without widening what the command may read
     * or write anywhere else.
     */
    unixSocketPaths?: readonly string[];
}): Promise<SandboxedCommand> {
    const hostPolicy = options.hostPolicy ?? {};
    const needsRefinedFullAccessBoundary =
        options.mode === "full_access" &&
        ((options.deniedReadPaths?.length ?? 0) > 0 ||
            (options.deniedWritePaths?.length ?? 0) > 0 ||
            createHostPolicyPrivatePaths(hostPolicy, options.environment).length > 0 ||
            options.networkFullAccess !== true ||
            options.networkAllowLocalBinding !== true);
    if (options.mode === "full_access" && !needsRefinedFullAccessBoundary) {
        return options.argv === undefined
            ? { command: options.command }
            : { args: options.argv.slice(1), command: options.argv[0]! };
    }
    const sandboxOptions = {
        ...options,
        hostPolicy,
        filesystemFullAccess:
            options.filesystemFullAccess === true || options.mode === "full_access",
        mode: options.mode === "full_access" ? ("workspace_write" as const) : options.mode,
        ...(options.mode === "full_access" ? { protectProjectMetadata: false } : {}),
    };
    if (process.platform === "darwin") return createMacOsSeatbeltCommand(sandboxOptions);
    if (process.platform === "linux") {
        return createLinuxBubblewrapCommand({
            ...sandboxOptions,
            commandCwd: options.commandCwd ?? options.cwd,
            mountProc: !(
                process.env.AGENT_COMPUTE_OUTER_ISOLATION === "docker" && existsSync("/.dockerenv")
            ),
        });
    }

    const configDirectory = await getConfigDirectory();
    const config = {
        // A disposable outer container can supply the isolation a nested sandbox cannot create.
        enableWeakerNestedSandbox:
            process.env.AGENT_COMPUTE_OUTER_ISOLATION === "docker" && existsSync("/.dockerenv"),
        network: {
            allowedDomains: options.networkFullAccess === true ? ["*"] : [],
            deniedDomains: [],
        },
        filesystem: await createSandboxFilesystemConfig({
            ...sandboxOptions,
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
