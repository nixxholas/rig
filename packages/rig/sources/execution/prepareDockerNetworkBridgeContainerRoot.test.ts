import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { prepareDockerNetworkBridgeContainerRoot } from "./prepareDockerNetworkBridgeContainerRoot.js";

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
        ).resolves.toBe("/workspace/.rig-network");
        expect(run).toHaveBeenCalledWith(
            expect.anything(),
            expect.arrayContaining(["/workspace/.rig-network"]),
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
