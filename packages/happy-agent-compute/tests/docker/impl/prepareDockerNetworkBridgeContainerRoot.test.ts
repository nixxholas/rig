import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { prepareDockerNetworkBridgeContainerRoot } from "../../../sources/docker/impl/prepareDockerNetworkBridgeContainerRoot.js";
import { DOCKER_NETWORK_BRIDGE_DIRECTORY } from "../../../sources/docker/impl/prepareDockerNetworkBridgeHostRoot.js";

describe("prepareDockerNetworkBridgeContainerRoot", () => {
    it("prepares a container-local root without requiring a host bind mount", async () => {
        const run = vi.fn(async () => ({
            exitCode: 0,
            stderr: Buffer.alloc(0),
            stdout: Buffer.alloc(0),
        }));

        await expect(
            prepareDockerNetworkBridgeContainerRoot({} as Dockerode.Container, "/workspace", {
                run,
            }),
        ).resolves.toBe(`/workspace/${DOCKER_NETWORK_BRIDGE_DIRECTORY}`);
        expect(run).toHaveBeenCalledWith(
            expect.anything(),
            expect.arrayContaining([`/workspace/${DOCKER_NETWORK_BRIDGE_DIRECTORY}`]),
        );
    });

    it("rejects an existing symlink or an unwritable root", async () => {
        const run = vi.fn(async () => ({
            exitCode: 1,
            stderr: Buffer.alloc(0),
            stdout: Buffer.alloc(0),
        }));

        await expect(
            prepareDockerNetworkBridgeContainerRoot({} as Dockerode.Container, "/workspace", {
                run,
            }),
        ).rejects.toThrow(
            "must be a real directory inside the workspace and writable by the container user",
        );
    });
});
