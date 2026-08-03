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
        const registration = await host.client.compute.register(localBash.handlers, {
            provisioningTimeoutMs: 120_000,
        });
        await host.compute.waitForProvider();
        await host.client.ready("Ready.");
        const preparationEvents: string[] = [];
        const subscription = await host.client.compute.events.subscribe((event) => {
            preparationEvents.push(event.phase);
        });

        await expect(host.client.compute.list()).resolves.toEqual([
            {
                health: "healthy",
                name: "local-bash",
                pluginFolder: "test-plugin",
                pluginName: "Test Plugin",
                provisioningTimeoutMs: 120_000,
            },
        ]);
        const instance = await host.client.compute.create({
            provider: "local-bash",
            workspaceSource: { path: source, type: "local_directory" },
        });
        expect(instance.state).toBe("unprovisioned");
        await expect(access(instanceParent)).rejects.toThrow();
        await expect(
            host.client.compute.files.write({
                bytes: Buffer.from(" from compute"),
                instanceId: instance.instanceId,
                path: "suffix.txt",
            }),
        ).rejects.toMatchObject({
            code: "preparing_compute",
            retryable: true,
            state: "provisioning",
        });
        await waitForReady(host, instance.instanceId);
        const acknowledgmentIndex = host.requests.findIndex((request) =>
            request.path.endsWith("/acknowledge"),
        );
        const firstProgressIndex = host.requests.findIndex((request) =>
            request.path.endsWith("/progress"),
        );
        expect(acknowledgmentIndex).toBeGreaterThanOrEqual(0);
        expect(firstProgressIndex).toBeGreaterThan(acknowledgmentIndex);
        await expect
            .poll(() => preparationEvents)
            .toEqual([
                "preparing_compute",
                "Checking local source code",
                "Copying files to compute",
                "verifying_compute",
                "ready",
            ]);
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

        await subscription.close();
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
        const phases: string[] = [];
        const context = {
            reportProgress: async (progress: { phase: string }) => {
                phases.push(progress.phase);
            },
            signal: new AbortController().signal,
        };
        const instanceId = await localBash.handlers.start(
            { workspaceSource: { path: source, type: "local_directory" } },
            context,
        );
        expect(phases).toEqual(["Checking local source code", "Copying files to compute"]);

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

    it("publishes a terminal event when provisioning is stopped", async () => {
        const host = await createHappyPluginTestHost(
            { computeProvider: { name: "test-compute" } },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);
        let releaseStart: () => void = () => undefined;
        const startReleased = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        let markStartEntered: () => void = () => undefined;
        const startEntered = new Promise<void>((resolve) => {
            markStartEntered = resolve;
        });
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
            start: async (_input, context) => {
                await context.reportProgress({
                    message: "Checking out code.",
                    phase: "checking_out_code",
                });
                markStartEntered();
                await startReleased;
                await context.reportProgress({
                    message: "Copying files to compute.",
                    phase: "copying_files_to_compute",
                });
                return "provider-instance";
            },
            stop: () => undefined,
            write: () => undefined,
        });
        await host.compute.waitForProvider();
        const phases: string[] = [];
        const subscription = await host.client.compute.events.subscribe((event) => {
            phases.push(event.phase);
        });
        const instance = await host.client.compute.create({
            provider: "test-compute",
            workspaceSource: { path: host.rootDirectory, type: "local_directory" },
        });

        await expect(
            host.client.compute.files.read({
                instanceId: instance.instanceId,
                path: "message.txt",
            }),
        ).rejects.toMatchObject({ code: "preparing_compute" });
        await startEntered;
        await host.client.compute.stop({ instanceId: instance.instanceId });
        await expect
            .poll(() => phases)
            .toEqual(["preparing_compute", "checking_out_code", "stopped"]);

        releaseStart();
        const completionPrefix = `/compute/providers/${registration.registrationId}/calls/`;
        await expect
            .poll(() =>
                host.requests.some(
                    (request) =>
                        request.method === "POST" &&
                        request.path.startsWith(completionPrefix) &&
                        request.path.slice(completionPrefix.length).length > 0 &&
                        !request.path.slice(completionPrefix.length).includes("/"),
                ),
            )
            .toBe(true);
        await subscription.close();
        await registration.close();
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
            start: async (_input, context) => {
                await context.reportProgress({
                    message: "Checking out code.",
                    phase: "checking_out_code",
                });
                await context.reportProgress({
                    message: "Copying files to compute.",
                    phase: "copying_files_to_compute",
                });
                return "provider-instance";
            },
            stop: () => undefined,
            write: () => undefined,
        });
        await host.compute.waitForProvider();
        const instance = await host.client.compute.create({
            provider: "test-compute",
            workspaceSource: { path: host.rootDirectory, type: "local_directory" },
        });
        const read = (path: string) =>
            host.client.compute.files.read({ instanceId: instance.instanceId, path });

        await expect(read("invalid")).rejects.toMatchObject({
            code: "preparing_compute",
            retryable: true,
            status: 409,
        });
        await waitForReady(host, instance.instanceId);
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
            start: async (_input, context) => {
                await context.reportProgress({
                    message: "Checking out code.",
                    phase: "checking_out_code",
                });
                await context.reportProgress({
                    message: "Copying files to compute.",
                    phase: "copying_files_to_compute",
                });
                return "provider-instance";
            },
            stop: () => undefined,
            write: () => undefined,
        });
        await host.compute.waitForProvider();
        const instance = await host.client.compute.create({
            provider: "test-compute",
            workspaceSource: { path: host.rootDirectory, type: "local_directory" },
        });
        await expect(
            host.client.compute.files.read({
                instanceId: instance.instanceId,
                path: "message.txt",
            }),
        ).rejects.toMatchObject({ code: "preparing_compute" });
        await waitForReady(host, instance.instanceId);
        await expect(
            host.client.compute.files.read({
                instanceId: instance.instanceId,
                path: "message.txt",
            }),
        ).resolves.toEqual(Buffer.alloc(0));

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

async function waitForReady(host: HappyPluginTestHost, instanceId: string): Promise<void> {
    await expect
        .poll(async () => {
            const instance = (await host.client.compute.instances.list()).find(
                (candidate) => candidate.instanceId === instanceId,
            );
            return instance?.state;
        })
        .toBe("ready");
}
