import type Dockerode from "dockerode";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DockerEnvironment } from "../../sources/docker/DockerEnvironment.js";

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

    it("reports a missing container as a clear, actionable error", async () => {
        inspect.mockRejectedValue({ statusCode: 404 });
        const environment = new DockerEnvironment(
            { container: "gone", workingDirectory: "/workspace" },
            "session",
            docker,
        );

        await expect(environment.container()).rejects.toThrow(
            "Docker container 'gone' was not found.",
        );
    });

    it("removes a managed container when its owner releases it", async () => {
        const created = {
            remove: vi.fn().mockResolvedValue(undefined),
            start: vi.fn().mockResolvedValue(undefined),
        } as unknown as Dockerode.Container;
        const managedDocker = {
            createContainer: vi.fn().mockResolvedValue(created),
            getContainer: vi.fn(() => ({
                inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
            })),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            {
                image: "compute-dev:latest",
                name: "managed-release-test",
                workingDirectory: "/workspace",
            },
            "session-managed",
            managedDocker,
        );

        await environment.container();
        await environment.release();

        expect(created.remove).toHaveBeenCalledOnce();
        expect(created.remove).toHaveBeenCalledWith({ force: true });
    });

    it("never removes a container the caller attached to", async () => {
        const attached = {
            inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
            remove: vi.fn(),
        } as unknown as Dockerode.Container;
        const attachedDocker = {
            getContainer: vi.fn(() => attached),
        } as unknown as Dockerode;
        const environment = new DockerEnvironment(
            { container: "developer-container", workingDirectory: "/workspace" },
            "session-attached",
            attachedDocker,
        );

        await environment.container();
        await environment.release();

        expect(attached.remove).not.toHaveBeenCalled();
    });

    it("coordinates concurrent creation of one shared managed container", async () => {
        const missing = { statusCode: 404 };
        const created = {
            remove: vi.fn().mockResolvedValue(undefined),
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
            image: "compute-dev:latest",
            name: "compute-workspace-1",
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

        await first.release();
        expect(created.remove).not.toHaveBeenCalled();

        await second.release();
        expect(created.remove).toHaveBeenCalledOnce();
    });
});
