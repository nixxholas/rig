import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalBashComputeProvider } from "../examples/local-bash/localBashCompute.ts";
import { createHappyPluginTestHost, type HappyPluginTestHost } from "../sources/index.js";

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
        ).rejects.toMatchObject({ status: 404 });

        await registration.close();
        await localBash.close();
    });

    it("releases a failed instance when it is stopped", async () => {
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
        await host.client.compute.stop({ instanceId: instance.instanceId });

        await expect(
            host.client.compute.stop({ instanceId: instance.instanceId }),
        ).rejects.toMatchObject({ status: 404 });
        await registration.close();
    });
});
