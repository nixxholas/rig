import { join, resolve } from "node:path";
import { posix } from "node:path";

import type Dockerode from "dockerode";

/**
 * Maps a container path to the host path that backs it through a bind mount.
 *
 * Managed network reaches a Docker sandbox through Unix sockets the host writes and the container
 * reads, which is only possible where the working directory is a bind mount shared with the host.
 * This finds the most specific bind mount covering the requested container path and translates the
 * path across it, failing closed when no shared mount exists.
 */
export async function resolveDockerBindMountPath(
    container: Dockerode.Container,
    containerPath: string,
): Promise<{ containerPath: string; hostPath: string }> {
    const details = await container.inspect();
    const mount = (details.Mounts ?? [])
        .filter(
            (candidate) =>
                candidate.Type === "bind" &&
                typeof candidate.Source === "string" &&
                typeof candidate.Destination === "string" &&
                isInside(candidate.Destination, containerPath),
        )
        .sort(
            (left, right) => (right.Destination?.length ?? 0) - (left.Destination?.length ?? 0),
        )[0];
    if (mount?.Source === undefined || mount.Destination === undefined) {
        throw new Error(
            "Managed network access in Docker requires the working directory to be on a bind mount shared with the host.",
        );
    }
    const suffix = posix.relative(mount.Destination, containerPath);
    return {
        containerPath: posix.join(mount.Destination, suffix),
        hostPath: resolve(join(mount.Source, ...suffix.split("/").filter(Boolean))),
    };
}

function isInside(root: string, target: string): boolean {
    const suffix = posix.relative(root, target);
    return (
        suffix === "" || (!suffix.startsWith("../") && suffix !== ".." && !posix.isAbsolute(suffix))
    );
}
