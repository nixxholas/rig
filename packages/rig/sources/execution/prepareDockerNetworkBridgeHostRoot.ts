import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const DOCKER_NETWORK_BRIDGE_DIRECTORY = ".rig-network";

export async function prepareDockerNetworkBridgeHostRoot(
    workspaceHostPath: string,
): Promise<string> {
    const canonicalWorkspace = await realpath(workspaceHostPath);
    const requestedRoot = join(canonicalWorkspace, DOCKER_NETWORK_BRIDGE_DIRECTORY);
    try {
        await mkdir(requestedRoot);
    } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
    }
    const metadata = await lstat(requestedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw invalidBridgeRoot();
    }
    const canonicalRoot = await realpath(requestedRoot);
    const suffix = relative(canonicalWorkspace, canonicalRoot);
    if (suffix.startsWith("..") || isAbsolute(suffix)) throw invalidBridgeRoot();
    // Rig owns this reserved runtime root. The container's configured UID needs write+traverse
    // for atomic config markers, but restricted commands receive the root through a read-only
    // bind and cannot mutate it. Omitting read prevents a different UID from listing command dirs.
    await chmod(canonicalRoot, 0o733);
    return canonicalRoot;
}

function invalidBridgeRoot(): Error {
    return new Error(
        "Docker managed network bridge root must be a real directory inside the workspace.",
    );
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}
