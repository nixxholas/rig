import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalBashComputeProvider } from "../examples/local-bash/localBashCompute.ts";
import {
    createHappyPluginTestHost,
    HappyComputeProviderError,
    type HappyPluginTestHost,
} from "../sources/index.js";

const hosts: HappyPluginTestHost[] = [];

afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
});

describe("Happy compute lifecycle", () => {
    it("drives the local-bash example through source copy, exec, files, and cleanup", async () => {
        const host = await createHappyPluginTestHost(
            { computeProvider: { name: "local-bash" } },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);
        const source = join(host.rootDirectory, "source");
        const instanceParent = join(host.environment.HAPPY_PLUGIN_DIRECTORY, "instances");
        await mkdir(source);
        await writeFile(join(source, "message.txt"), "hello");

        const localBash = createLocalBashComputeProvider(instanceParent);
        const registration = await host.client.compute.register(localBash.handlers);
        await host.compute.waitForProvider();
        await host.client.ready("Ready.");

        await expect(host.client.compute.list()).resolves.toEqual([
            {
                health: "healthy",
                name: "local-bash",
                pluginFolder: "test-plugin",
                pluginName: "Test Plugin",
            },
        ]);
        const instance = await host.client.compute.start({
            provider: "local-bash",
            workspaceSource: { path: source, type: "local_directory" },
        });
        await host.client.compute.files.write({
            bytes: Buffer.from(" from compute"),
            instanceId: instance.instanceId,
            path: "suffix.txt",
        });
        await expect(
            host.client.compute.exec({
                command: "cat suffix.txt >> message.txt; printf 'done' >&2",
                instanceId: instance.instanceId,
            }),
        ).resolves.toEqual({
            exitCode: 0,
            stderr: "done",
            stderrTruncated: false,
            stdout: "",
            stdoutTruncated: false,
            timedOut: false,
        });
        await expect(
            host.client.compute.files.read({
                instanceId: instance.instanceId,
                path: "message.txt",
            }),
        ).resolves.toEqual(Buffer.from("hello from compute"));

        await host.client.compute.stop({ instanceId: instance.instanceId });
        await expect(access(source)).resolves.toBeUndefined();
        await expect(readdir(instanceParent)).resolves.toEqual([]);
        await expect(
            host.client.compute.files.read({
                instanceId: instance.instanceId,
                path: "message.txt",
            }),
        ).rejects.toMatchObject({
            code: "instance_failed",
            state: "stopped",
            status: 409,
        });
        await expect(host.client.compute.instances.list()).resolves.toEqual([
            expect.objectContaining({
                instanceId: instance.instanceId,
                state: "stopped",
            }),
        ]);

        await registration.close();
        await localBash.close();
    });

    it("keeps the local-bash provider stop handler idempotent", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const source = join(host.rootDirectory, "source");
        const instanceParent = join(host.environment.HAPPY_PLUGIN_DIRECTORY, "instances");
        await mkdir(source);
        await writeFile(join(source, "message.txt"), "hello");
        const localBash = createLocalBashComputeProvider(instanceParent);
        const context = { signal: new AbortController().signal };
        const instanceId = await localBash.handlers.start(
            { workspaceSource: { path: source, type: "local_directory" } },
            context,
        );

        await expect(
            Promise.resolve(localBash.handlers.read({ instanceId, path: "missing.txt" }, context)),
        ).rejects.toMatchObject({
            code: "invalid_request",
            message: expect.stringContaining("requested local Bash compute file is unavailable"),
        });
        const [instanceFolder] = await readdir(instanceParent);
        const materializedFile = join(instanceParent, instanceFolder!, "workspace", "message.txt");
        const cancellation = new AbortController();
        cancellation.abort();
        await expect(
            Promise.resolve(
                localBash.handlers.write(
                    {
                        bytes: Buffer.from("torn"),
                        instanceId,
                        path: "message.txt",
                    },
                    { signal: cancellation.signal },
                ),
            ),
        ).rejects.toThrow();
        await expect(readFile(materializedFile, "utf8")).resolves.toBe("hello");
        await expect(readdir(join(instanceParent, instanceFolder!, "workspace"))).resolves.toEqual([
            "message.txt",
        ]);
        await localBash.handlers.stop({ instanceId }, context);
        await expect(
            Promise.resolve(localBash.handlers.stop({ instanceId }, context)),
        ).resolves.toBeUndefined();
        await expect(
            Promise.resolve(localBash.handlers.read({ instanceId, path: "message.txt" }, context)),
        ).rejects.toMatchObject({
            code: "instance_not_found",
            message: "The local Bash compute instance was not found.",
        });
        await localBash.close();
    });

    it("matches daemon status and retryability for typed provider errors", async () => {
        const host = await createHappyPluginTestHost(
            { computeProvider: { name: "test-compute" } },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);
        const registration = await host.client.compute.register({
            exec: () => ({
                exitCode: 0,
                stderr: "",
                stderrTruncated: false,
                stdout: "",
                stdoutTruncated: false,
                timedOut: false,
            }),
            read: ({ path }) => {
                switch (path) {
                    case "invalid":
                        throw new HappyComputeProviderError("invalid_request", "Invalid path.");
                    case "missing":
                        throw new HappyComputeProviderError(
                            "instance_not_found",
                            "Missing instance.",
                        );
                    case "capacity":
                        throw new HappyComputeProviderError("capacity_exhausted", "No capacity.");
                    case "unhealthy":
                        throw new HappyComputeProviderError(
                            "provider_unhealthy",
                            "Provider unhealthy.",
                        );
                    case "deadline":
                        throw new HappyComputeProviderError(
                            "deadline_exceeded",
                            "Provider deadline.",
                        );
                    default:
                        return Buffer.alloc(0);
                }
            },
            start: () => "provider-instance",
            stop: () => undefined,
            write: () => undefined,
        });
        await host.compute.waitForProvider();
        const instance = await host.client.compute.start({
            provider: "test-compute",
            workspaceSource: { path: host.rootDirectory, type: "local_directory" },
        });
        const read = (path: string) =>
            host.client.compute.files.read({ instanceId: instance.instanceId, path });

        await expect(read("invalid")).rejects.toMatchObject({
            code: "invalid_request",
            retryable: false,
            status: 400,
        });
        await expect(read("missing")).rejects.toMatchObject({
            code: "instance_not_found",
            retryable: false,
            status: 404,
        });
        await expect(read("capacity")).rejects.toMatchObject({
            code: "capacity_exhausted",
            retryable: true,
            status: 429,
        });
        await expect(read("unhealthy")).rejects.toMatchObject({
            code: "provider_unhealthy",
            retryable: false,
            status: 503,
        });
        await expect(read("deadline")).rejects.toMatchObject({
            code: "deadline_exceeded",
            retryable: true,
            status: 504,
        });

        await host.client.compute.stop({ instanceId: instance.instanceId });
        await registration.close();
    });

    it("retains a failed instance tombstone after provider loss", async () => {
        const host = await createHappyPluginTestHost(
            { computeProvider: { name: "test-compute" } },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);
        const registration = await host.client.compute.register({
            exec: () => ({
                exitCode: 0,
                stderr: "",
                stderrTruncated: false,
                stdout: "",
                stdoutTruncated: false,
                timedOut: false,
            }),
            read: () => Buffer.alloc(0),
            start: () => "provider-instance",
            stop: () => undefined,
            write: () => undefined,
        });
        await host.compute.waitForProvider();
        const instance = await host.client.compute.start({
            provider: "test-compute",
            workspaceSource: { path: host.rootDirectory, type: "local_directory" },
        });

        host.compute.disconnectProvider();
        await expect.poll(() => registration.status).toBe("closed");
        await expect(
            host.client.compute.stop({ instanceId: instance.instanceId }),
        ).rejects.toMatchObject({
            code: "instance_failed",
            state: "failed",
            status: 409,
        });
        await expect(host.client.compute.instances.list()).resolves.toEqual([
            expect.objectContaining({
                instanceId: instance.instanceId,
                state: "failed",
            }),
        ]);
        await registration.close();
    });
});
