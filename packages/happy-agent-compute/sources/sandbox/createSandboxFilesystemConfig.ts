import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import type { ComputePermissionMode } from "../ComputePermissions.js";

import { createHostPolicyPrivatePaths } from "./impl/createHostPolicyPrivatePaths.js";
import { createSensitiveReadPaths } from "./impl/createSensitiveReadPaths.js";
import { findExecutableSearchPaths } from "./impl/findExecutableSearchPaths.js";
import { findGitWritablePaths } from "./impl/findGitWritablePaths.js";
import { projectProtectedFileNames } from "./impl/projectProtectedFileNames.js";
import { resolvePotentialPath } from "./impl/resolvePotentialPath.js";

export async function createSandboxFilesystemConfig(options: {
    additionalReadablePaths?: readonly string[];
    additionalWritablePaths?: readonly string[];
    alwaysWritablePaths?: readonly string[];
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    filesystemFullAccess?: boolean;
    hostPolicy?: ComputeHostPolicy;
    homeDirectory?: string;
    mode: ComputePermissionMode;
    protectProjectMetadata?: boolean;
    deniedReadPaths?: readonly string[];
    deniedWritePaths?: readonly string[];
    sandboxConfigDirectory?: string;
    temporaryDirectory?: string;
    unixSocketPaths?: readonly string[];
}) {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const hostPolicy = options.hostPolicy ?? {};
    const privatePaths = createHostPolicyPrivatePaths(hostPolicy, environment);
    // Connecting to a Unix socket needs write access to the socket itself, so an explicitly
    // granted socket is writable even though nothing around it is.
    const writablePaths = [temporaryDirectory, ...(options.unixSocketPaths ?? [])];
    if (options.mode === "workspace_write" || options.mode === "auto") {
        writablePaths.push(options.cwd);
        if (options.protectProjectMetadata !== false) {
            writablePaths.push(...(await findGitWritablePaths(options.cwd)));
        }
        // Space a command's own declared permissions grant it. Read only never reaches here, so a
        // mode that withholds the workspace cannot be widened past it.
        writablePaths.push(...(options.additionalWritablePaths ?? []));
        writablePaths.push(...(options.alwaysWritablePaths ?? []));
        if (options.filesystemFullAccess === true) writablePaths.push(sep);
    }

    const denyRead =
        options.filesystemFullAccess === true && options.mode !== "read_only"
            ? [
                  options.sandboxConfigDirectory,
                  ...privatePaths,
                  ...(options.deniedReadPaths ?? []),
              ].filter((path): path is string => typeof path === "string" && path.length > 0)
            : createSensitiveReadPaths({
                  additionalPaths: [
                      options.sandboxConfigDirectory,
                      ...(options.deniedReadPaths ?? []),
                  ],
                  environment,
                  hostPolicy,
                  homeDirectory,
              });
    const denyWrite = [
        ...privatePaths,
        ...(options.protectProjectMetadata === false
            ? []
            : projectProtectedFileNames(hostPolicy).map((name) => join(options.cwd, name))),
        options.sandboxConfigDirectory,
        ...(options.deniedWritePaths ?? []),
    ].filter(
        (path, index, paths): path is string =>
            typeof path === "string" && path.length > 0 && paths.indexOf(path) === index,
    );
    const canonicalHomeDirectory = await resolvePotentialPath(homeDirectory);
    const executableSearchPaths =
        process.platform === "win32"
            ? []
            : await findExecutableSearchPaths({
                  cwd: options.cwd,
                  environment,
                  homeDirectory,
                  temporaryDirectory,
              });
    const readableHomeToolPaths = executableSearchPaths.filter((path) =>
        path.startsWith(`${canonicalHomeDirectory}${sep}`),
    );

    return {
        denyRead,
        allowRead: [
            options.cwd,
            ...(hostPolicy.readableDirectories ?? []),
            ...readableHomeToolPaths,
            ...(options.additionalReadablePaths ?? []),
        ],
        allowWrite: writablePaths,
        denyWrite,
    };
}
