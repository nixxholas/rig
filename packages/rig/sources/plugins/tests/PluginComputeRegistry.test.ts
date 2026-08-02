import { describe, expect, it } from "vitest";

import type { HappyComputeEvent } from "happy-plugins/internal";

import { PluginComputeRegistry } from "../PluginComputeRegistry.js";

describe("PluginComputeRegistry", () => {
    it("reports voluntary provider unregistration as stopped", () => {
        const retired: unknown[] = [];
        const registry = new PluginComputeRegistry();
        const provider = registry.createConnection(
            {
                compute: { name: "local-bash" },
                folder: "local-bash",
                name: "Local Bash",
            },
            {
                onRequiredRegistrationRetired: (retirement) => retired.push(retirement),
            },
        );
        const registrationId = provider.register();
        provider.attach(registrationId, () => true);

        provider.unregister(registrationId);

        expect(retired).toEqual([
            {
                reason: "The plugin unregistered its compute provider.",
                status: "stopped",
            },
        ]);
    });

    it("fails only the instance whose call misses its deadline", async () => {
        const registry = new PluginComputeRegistry({ callTimeoutMs: 10 });
        const provider = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const consumer = registry.createConnection({
            folder: "consumer",
            name: "Consumer",
        });
        const registrationId = provider.register();
        const events: HappyComputeEvent[] = [];
        let nextProviderInstance = 1;
        provider.attach(registrationId, (event) => {
            events.push(event);
            if (event.type === "call" && event.operation === "start") {
                provider.complete(registrationId, event.callId, {
                    operation: "start",
                    result: { instanceId: `provider-instance-${String(nextProviderInstance++)}` },
                });
            }
            if (event.type === "call" && event.operation === "exec") {
                provider.complete(registrationId, event.callId, {
                    operation: "exec",
                    result: {
                        exitCode: 0,
                        stderrBase64: "",
                        stderrTruncated: false,
                        stdoutBase64: "",
                        stdoutTruncated: false,
                        timedOut: false,
                    },
                });
            }
            return true;
        });
        const firstInstance = await registry.start(
            {
                provider: "local-bash",
                workspaceSource: { path: "/workspace/source", type: "local_directory" },
            },
            consumer.generation,
        );
        const secondInstance = await registry.start(
            {
                provider: "local-bash",
                workspaceSource: { path: "/workspace/source", type: "local_directory" },
            },
            consumer.generation,
        );

        await expect(
            registry.read(
                { instanceId: firstInstance.instanceId, path: "message.txt" },
                consumer.generation,
            ),
        ).rejects.toMatchObject({ code: "deadline_missed" });
        expect(events.at(-1)).toMatchObject({ type: "cancel" });
        await expect(
            registry.exec(
                {
                    command: "pwd",
                    instanceId: secondInstance.instanceId,
                    timeoutMs: 100,
                },
                consumer.generation,
            ),
        ).resolves.toMatchObject({ exitCode: 0 });
        expect(registry.list()).toHaveLength(1);
    });

    it("rejects old instances after a provider plugin restarts", async () => {
        const registry = new PluginComputeRegistry();
        const consumer = registry.createConnection({
            folder: "consumer",
            name: "Consumer",
        });
        const first = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const firstRegistrationId = first.register();
        first.attach(firstRegistrationId, (event) => {
            if (event.type === "call" && event.operation === "start") {
                first.complete(firstRegistrationId, event.callId, {
                    operation: "start",
                    result: { instanceId: "provider-instance-1" },
                });
            }
            return true;
        });
        const instance = await registry.start(
            {
                provider: "local-bash",
                workspaceSource: { path: "/workspace/source", type: "local_directory" },
            },
            consumer.generation,
        );

        first.close();
        const replacement = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const replacementRegistrationId = replacement.register();
        replacement.attach(replacementRegistrationId, () => true);

        expect(registry.list()).toEqual([
            {
                name: "local-bash",
                pluginFolder: "local-bash",
                pluginName: "Local Bash",
            },
        ]);
        await expect(
            registry.read(
                { instanceId: instance.instanceId, path: "message.txt" },
                consumer.generation,
            ),
        ).rejects.toMatchObject({ code: "stale_generation" });
    });

    it("stops and releases an instance after that instance has failed", async () => {
        const registry = new PluginComputeRegistry({ callTimeoutMs: 10 });
        const provider = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const consumer = registry.createConnection({ folder: "consumer", name: "Consumer" });
        const registrationId = provider.register();
        const stopped: string[] = [];
        provider.attach(registrationId, (event) => {
            if (event.type !== "call") return true;
            if (event.operation === "start") {
                provider.complete(registrationId, event.callId, {
                    operation: "start",
                    result: { instanceId: "provider-instance" },
                });
            }
            if (event.operation === "stop") {
                stopped.push(event.instanceId);
                provider.complete(registrationId, event.callId, {
                    operation: "stop",
                    result: {},
                });
            }
            return true;
        });
        const instance = await registry.start(
            {
                provider: "local-bash",
                workspaceSource: { path: "/workspace/source", type: "local_directory" },
            },
            consumer.generation,
        );
        await expect(
            registry.read(
                { instanceId: instance.instanceId, path: "missing.txt" },
                consumer.generation,
            ),
        ).rejects.toMatchObject({ code: "deadline_missed" });

        await registry.stop(instance.instanceId, consumer.generation);

        expect(stopped).toEqual(["provider-instance"]);
        await expect(registry.stop(instance.instanceId, consumer.generation)).rejects.toMatchObject(
            { code: "instance_not_found" },
        );
    });

    it("stops and releases instances when their consumer generation retires", async () => {
        const registry = new PluginComputeRegistry();
        const provider = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const consumer = registry.createConnection({ folder: "consumer", name: "Consumer" });
        const replacement = registry.createConnection({
            folder: "consumer",
            name: "Consumer",
        });
        const registrationId = provider.register();
        let resolveStopped: () => void = () => undefined;
        const stopped = new Promise<void>((resolve) => {
            resolveStopped = resolve;
        });
        provider.attach(registrationId, (event) => {
            if (event.type !== "call") return true;
            if (event.operation === "start") {
                provider.complete(registrationId, event.callId, {
                    operation: "start",
                    result: { instanceId: "provider-instance" },
                });
            }
            if (event.operation === "stop") {
                provider.complete(registrationId, event.callId, {
                    operation: "stop",
                    result: {},
                });
                resolveStopped();
            }
            return true;
        });
        const instance = await registry.start(
            {
                provider: "local-bash",
                workspaceSource: { path: "/workspace/source", type: "local_directory" },
            },
            consumer.generation,
        );

        consumer.close();
        await stopped;

        await expect(
            registry.read(
                { instanceId: instance.instanceId, path: "message.txt" },
                replacement.generation,
            ),
        ).rejects.toMatchObject({ code: "instance_not_found" });
    });

    it("does not publish an instance when the provider retires during start", async () => {
        const registry = new PluginComputeRegistry();
        const provider = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const consumer = registry.createConnection({ folder: "consumer", name: "Consumer" });
        const registrationId = provider.register();
        let detach: () => void = () => undefined;
        detach = provider.attach(registrationId, (event) => {
            if (event.type === "call" && event.operation === "start") {
                provider.complete(registrationId, event.callId, {
                    operation: "start",
                    result: { instanceId: "orphaned-provider-instance" },
                });
                detach();
            }
            return true;
        });

        await expect(
            registry.start(
                {
                    provider: "local-bash",
                    workspaceSource: { path: "/workspace/source", type: "local_directory" },
                },
                consumer.generation,
            ),
        ).rejects.toMatchObject({ code: "stale_generation" });
        expect(registry.list()).toEqual([]);
    });

    it("stops a just-created provider instance when its consumer retires during start", async () => {
        const registry = new PluginComputeRegistry();
        const provider = registry.createConnection({
            compute: { name: "local-bash" },
            folder: "local-bash",
            name: "Local Bash",
        });
        const consumer = registry.createConnection({ folder: "consumer", name: "Consumer" });
        const registrationId = provider.register();
        const stopped: string[] = [];
        provider.attach(registrationId, (event) => {
            if (event.type !== "call") return true;
            if (event.operation === "start") {
                provider.complete(registrationId, event.callId, {
                    operation: "start",
                    result: { instanceId: "just-created-provider-instance" },
                });
                consumer.close();
            }
            if (event.operation === "stop") {
                stopped.push(event.instanceId);
                provider.complete(registrationId, event.callId, {
                    operation: "stop",
                    result: {},
                });
            }
            return true;
        });

        await expect(
            registry.start(
                {
                    provider: "local-bash",
                    workspaceSource: { path: "/workspace/source", type: "local_directory" },
                },
                consumer.generation,
            ),
        ).rejects.toMatchObject({ code: "stale_generation" });
        expect(stopped).toEqual(["just-created-provider-instance"]);
    });
});
