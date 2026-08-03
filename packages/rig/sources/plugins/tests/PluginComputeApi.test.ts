import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHappyPluginClient, HappyComputeProviderError } from "happy-plugins";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createPluginApiServer } from "../createPluginApiServer.js";
import { PluginComputeRegistry } from "../PluginComputeRegistry.js";
import { PluginStartupState } from "../PluginStartupState.js";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("plugin compute API", () => {
    it("forwards provider and consumer calls over the authenticated plugin socket", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const source = join(directory, "source");
        await mkdir(source);
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginComputeRegistry();
        cleanup.push(() => registry.close());
        const compute = registry.createConnection({
            compute: { name: "memory-compute" },
            folder: "memory-compute",
            name: "Memory Compute",
        });
        const server = createPluginApiServer({
            compute,
            computeRegistry: registry,
            listPlugins: async () => [],
            pluginFolder: "memory-compute",
            pluginName: "Memory Compute",
            startup: new PluginStartupState(),
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
        const client = createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        });
        const files = new Map<string, Buffer>();
        const commands: string[] = [];
        let starts = 0;
        const handlers = {
            exec({ command }) {
                commands.push(command);
                files.set("command.txt", Buffer.from(command));
                return {
                    exitCode: 0,
                    stderr: "",
                    stderrTruncated: false,
                    stdout: "executed",
                    stdoutTruncated: false,
                    timedOut: false,
                };
            },
            read({ path }) {
                const bytes = files.get(path);
                if (bytes === undefined) {
                    throw new HappyComputeProviderError("invalid_request", "Missing compute file.");
                }
                return bytes;
            },
            async start(_input, context) {
                starts += 1;
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
            stop() {
                files.clear();
            },
            write({ bytes, path }) {
                files.set(path, Buffer.from(bytes));
            },
        } satisfies Parameters<typeof client.compute.register>[0];
        const registration = await client.compute.register(handlers);
        await expect(client.compute.register(handlers)).rejects.toMatchObject({
            code: "invalid_request",
            retryable: false,
            status: 400,
        });
        await client.ready("Ready.");
        const preparationEvents: string[] = [];
        const subscription = await client.compute.events.subscribe((event) => {
            preparationEvents.push(event.phase);
        });

        await expect(client.compute.list()).resolves.toEqual([
            {
                health: "healthy",
                name: "memory-compute",
                pluginFolder: "memory-compute",
                pluginName: "Memory Compute",
                provisioningTimeoutMs: 300_000,
            },
        ]);
        const instance = await client.compute.create({
            provider: "memory-compute",
            workspaceSource: { path: source, type: "local_directory" },
        });
        expect(instance).toMatchObject({ state: "unprovisioned" });
        expect(starts).toBe(0);
        expect(commands).toEqual([]);
        await expect(client.compute.instances.list()).resolves.toEqual([
            expect.objectContaining({
                instanceId: instance.instanceId,
                state: "unprovisioned",
            }),
        ]);
        await expect(
            client.compute.files.write({
                bytes: Buffer.from("written"),
                instanceId: instance.instanceId,
                path: "written.txt",
            }),
        ).rejects.toMatchObject({
            code: "preparing_compute",
            elapsedMs: expect.any(Number),
            lastProgressAt: expect.any(Number),
            phase: expect.any(String),
            retryable: true,
            startedAt: expect.any(Number),
            state: "provisioning",
            status: 409,
        });
        await expect
            .poll(async () => {
                const current = (await client.compute.instances.list()).find(
                    (candidate) => candidate.instanceId === instance.instanceId,
                );
                return current?.state;
            })
            .toBe("ready");
        expect(starts).toBe(1);
        expect(commands).toEqual(["true"]);
        await expect
            .poll(() => preparationEvents)
            .toEqual([
                "preparing_compute",
                "checking_out_code",
                "copying_files_to_compute",
                "verifying_compute",
                "ready",
            ]);
        await client.compute.files.write({
            bytes: Buffer.from("written"),
            instanceId: instance.instanceId,
            path: "written.txt",
        });
        await expect(
            client.compute.files.read({
                instanceId: instance.instanceId,
                path: "written.txt",
            }),
        ).resolves.toEqual(Buffer.from("written"));
        for (let failure = 0; failure < 3; failure += 1) {
            await expect(
                client.compute.files.read({
                    instanceId: instance.instanceId,
                    path: "missing.txt",
                }),
            ).rejects.toMatchObject({
                code: "invalid_request",
                retryable: false,
                status: 400,
            });
        }
        await expect(client.compute.list()).resolves.toEqual([
            {
                health: "healthy",
                name: "memory-compute",
                pluginFolder: "memory-compute",
                pluginName: "Memory Compute",
                provisioningTimeoutMs: 300_000,
            },
        ]);
        await expect(
            client.compute.exec({
                command: "printf changed",
                instanceId: instance.instanceId,
            }),
        ).resolves.toEqual({
            exitCode: 0,
            stderr: "",
            stderrTruncated: false,
            stdout: "executed",
            stdoutTruncated: false,
            timedOut: false,
        });
        await expect(
            client.compute.files.read({
                instanceId: instance.instanceId,
                path: "command.txt",
            }),
        ).resolves.toEqual(Buffer.from("printf changed"));
        await client.compute.stop({ instanceId: instance.instanceId });
        await expect(
            client.compute.files.read({
                instanceId: instance.instanceId,
                path: "written.txt",
            }),
        ).rejects.toMatchObject({
            code: "instance_failed",
            state: "stopped",
            status: 409,
        });
        await expect(client.compute.instances.list()).resolves.toEqual([
            expect.objectContaining({
                instanceId: instance.instanceId,
                state: "stopped",
            }),
        ]);

        await subscription.close();
        await registration.close();
    });
});

function closeServer(server: ReturnType<typeof createPluginApiServer>): Promise<void> {
    if (!server.listening) {
        server.closeAllConnections();
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}
