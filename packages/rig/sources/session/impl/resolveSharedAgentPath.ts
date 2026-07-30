import { relative, resolve, sep } from "node:path";
import { posix } from "node:path";

import type { DockerExecutionConfig, DockerMountConfig } from "../../execution/index.js";

export function resolveSharedAgentPath(
    sender: { cwd: string; docker?: DockerExecutionConfig; sessionId: string },
    target: { cwd: string; docker?: DockerExecutionConfig; sessionId: string },
): string | undefined {
    if (sender.docker === undefined && target.docker === undefined) return target.cwd;
    if (
        sender.docker !== undefined &&
        target.docker !== undefined &&
        containerKey(sender.docker, sender.sessionId) ===
            containerKey(target.docker, target.sessionId)
    ) {
        return target.docker.workingDirectory;
    }

    const hostPath =
        target.docker === undefined
            ? target.cwd
            : containerPathToHost(target.docker, target.docker.workingDirectory);
    if (hostPath === undefined) return undefined;
    return sender.docker === undefined ? hostPath : hostPathToContainer(sender.docker, hostPath);
}

function containerKey(config: DockerExecutionConfig, sessionId: string): string {
    const socket = config.socketPath ?? "/var/run/docker.sock";
    if (config.container !== undefined) return `${socket}:container:${config.container}`;
    return `${socket}:managed:${config.name ?? `rig-${sessionId}`}`;
}

function containerPathToHost(
    config: DockerExecutionConfig,
    containerPath: string,
): string | undefined {
    const match = bestMount(config.mounts, containerPath, (mount) => mount.target, posix.relative);
    if (match === undefined) return undefined;
    const suffix = posix.relative(posix.resolve(match.target), posix.resolve(containerPath));
    return resolve(match.source, suffix);
}

function hostPathToContainer(config: DockerExecutionConfig, hostPath: string): string | undefined {
    const match = bestMount(config.mounts, hostPath, (mount) => mount.source, relative);
    if (match === undefined) return undefined;
    const suffix = relative(resolve(match.source), resolve(hostPath));
    return posix.resolve(match.target, suffix.split(sep).join(posix.sep));
}

function bestMount(
    mounts: readonly DockerMountConfig[] | undefined,
    path: string,
    root: (mount: DockerMountConfig) => string,
    relativePath: (from: string, to: string) => string,
): DockerMountConfig | undefined {
    return (mounts ?? [])
        .filter((mount) => isInside(relativePath(root(mount), path)))
        .sort((left, right) => root(right).length - root(left).length)[0];
}

function isInside(relativePath: string): boolean {
    return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`))
    );
}
