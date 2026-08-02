import Dockerode from "dockerode";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DockerEnvironment } from "./DockerEnvironment.js";

describe("DockerEnvironment", () => {
    const inspect = vi.fn();
    const docker = {
        getContainer: vi.fn(() => ({ inspect })),
    } as unknown as Dockerode;

    beforeEach(() => {
        inspect.mockReset();
    });

    it("retries container resolution after a transient failure", async () => {
        inspect
            .mockRejectedValueOnce(new Error("Docker socket was temporarily unavailable."))
            .mockResolvedValueOnce({ State: { Running: true } });
        const environment = new DockerEnvironment(
            { container: "dev", workingDirectory: "/workspace" },
            "session",
            docker,
        );

        await expect(environment.container()).rejects.toThrow("temporarily unavailable");
        await expect(environment.container()).resolves.toBeDefined();
        expect(inspect).toHaveBeenCalledTimes(2);
    });

    it("coordinates concurrent creation of one shared managed container", async () => {
        const missing = { statusCode: 404 };
        const created = {
            remove: vi.fn(),
            start: vi.fn().mockResolvedValue(undefined),
        } as unknown as Dockerode.Container;
        const createContainer = vi.fn(async () => {
            await Promise.resolve();
            return created;
        });
        const sharedDocker = {
            createContainer,
            getContainer: vi.fn(() => ({
                inspect: vi.fn().mockRejectedValue(missing),
            })),
        } as unknown as Dockerode;
        const config = {
            image: "rig-dev:latest",
            name: "rig-workspace-workspace-1-1",
            workingDirectory: "/workspace",
        };
        const first = new DockerEnvironment(config, "session-1", sharedDocker);
        const second = new DockerEnvironment(config, "session-2", sharedDocker);

        await expect(Promise.all([first.container(), second.container()])).resolves.toEqual([
            created,
            created,
        ]);
        expect(createContainer).toHaveBeenCalledTimes(1);
        expect(created.start).toHaveBeenCalledTimes(1);
    });
});
