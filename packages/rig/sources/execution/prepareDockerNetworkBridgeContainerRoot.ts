import { posix } from "node:path";

import type Dockerode from "dockerode";

import { runDockerExec } from "./runDockerExec.js";
import { DOCKER_NETWORK_BRIDGE_DIRECTORY } from "./prepareDockerNetworkBridgeHostRoot.js";

export async function prepareDockerNetworkBridgeContainerRoot(
    container: Dockerode.Container,
    workspaceCwd: string,
    options: { run?: typeof runDockerExec } = {},
): Promise<string> {
    const root = posix.join(workspaceCwd, DOCKER_NETWORK_BRIDGE_DIRECTORY);
    const run = options.run ?? runDockerExec;
    const result = await run(container, [
        "/bin/sh",
        "-c",
        [
            "root=$1",
            'if mkdir -m 733 "$root" 2>/dev/null; then created=1; fi',
            '[ -d "$root" ] && [ ! -L "$root" ] || exit 1',
            'if [ "${created:-0}" = 1 ]; then chmod 733 "$root" || exit 1; fi',
            '[ -w "$root" ] && [ -x "$root" ]',
        ].join("\n"),
        "rig",
        root,
    ]);
    if (result.exitCode !== 0) {
        throw new Error(
            "Docker managed network bridge root must be a real directory inside the workspace and writable by the container user.",
        );
    }
    return root;
}
