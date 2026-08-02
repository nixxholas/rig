import Dockerode from "dockerode";

import type { DockerExecutionConfig } from "../execution/index.js";

export function createPluginDockerClient(config?: DockerExecutionConfig): Dockerode {
    return config?.socketPath === undefined
        ? new Dockerode()
        : new Dockerode({ socketPath: config.socketPath });
}
