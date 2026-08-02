import { isAbsolute, resolve } from "node:path";

import { CONTAINER_DOCS_PATH, getBundledDocsRoot } from "./getBundledDocsRoot.js";
import { getGeneratedDirectory } from "../generated-media/index.js";
import { CONTAINER_GENERATED_PATH } from "./getGeneratedMount.js";
import type { DockerExecutionConfig } from "./DockerExecutionConfig.js";

export function resolveDockerExecutionConfig(
    config: DockerExecutionConfig,
    hostCwd: string,
): DockerExecutionConfig {
    const mounts = (config.mounts ?? []).map((mount) => ({
        ...mount,
        source: isAbsolute(mount.source) ? mount.source : resolve(hostCwd, mount.source),
    }));
    if (mounts.some((mount) => mount.target === CONTAINER_GENERATED_PATH)) {
        throw new Error(
            `Docker mount target '${CONTAINER_GENERATED_PATH}' is reserved for Rig-generated media.`,
        );
    }
    // Mounts only apply when Rig creates the container; an existing container keeps its own.
    if (config.container === undefined && !mounts.some((m) => m.target === CONTAINER_DOCS_PATH)) {
        mounts.push({ readOnly: true, source: getBundledDocsRoot(), target: CONTAINER_DOCS_PATH });
    }
    if (config.container === undefined) {
        mounts.push({
            readOnly: true,
            source: getGeneratedDirectory(),
            target: CONTAINER_GENERATED_PATH,
        });
    }
    return mounts.length === 0 ? { ...config } : { ...config, mounts };
}
