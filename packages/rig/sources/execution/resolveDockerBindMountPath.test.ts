import type Dockerode from "dockerode";
import { describe, expect, it } from "vitest";

import { resolveDockerBindMountPath } from "./resolveDockerBindMountPath.js";

describe("resolveDockerBindMountPath", () => {
    it("maps a nested container workspace through the most specific bind mount", async () => {
        const container = {
            async inspect() {
                return {
                    Mounts: [
                        { Destination: "/workspace", Source: "/host/repository", Type: "bind" },
                        {
                            Destination: "/workspace/cache",
                            Source: "/host/cache",
                            Type: "bind",
                        },
                    ],
                };
            },
        } as unknown as Dockerode.Container;

        await expect(
            resolveDockerBindMountPath(container, "/workspace/cache/project"),
        ).resolves.toEqual({
            containerPath: "/workspace/cache/project",
            hostPath: "/host/cache/project",
        });
    });

    it("fails closed when the workspace is not shared with the host", async () => {
        const container = {
            async inspect() {
                return { Mounts: [] };
            },
        } as unknown as Dockerode.Container;

        await expect(resolveDockerBindMountPath(container, "/workspace")).rejects.toThrow(
            "requires the working directory to be on a bind mount",
        );
    });
});
