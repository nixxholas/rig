import { afterEach, describe, expect, it, vi } from "vitest";

import type { HappyComputeEvent } from "happy-plugins/internal";

import {
    PluginComputeRegistry,
    type PluginComputeRegistryOptions,
} from "../PluginComputeRegistry.js";

const registries: PluginComputeRegistry[] = [];

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(registries.splice(0).map((registry) => registry.close()));
});

describe("PluginComputeRegistry", () => {
    it("degrades after two consecutive provider failures and fails terminally after three", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        const sibling = await harness.start();
        harness.respondWithProviderError();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "provider_lost",
        });
        expect(harness.registry.list()[0]?.health).toBe("failed");
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
        });
        await expect(harness.read(sibling.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
        });
        await expect(harness.start()).rejects.toMatchObject({
            code: "provider_unhealthy",
            retryable: false,
        });
    });

    it("resets consecutive failures and restores a degraded provider after a success", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        harness.respondWithProviderError();
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");

        harness.respondNormally();
        await expect(harness.read(instance.instanceId)).resolves.toMatchObject({
            contentBase64: "",
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");

        harness.respondWithProviderError();
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("does not count consumer instance and capacity errors against provider health", async () => {
        const harness = createHarness({ maxInstances: 1 });
        const instance = await harness.start();
        harness.respondWithProviderError();
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });

        for (let index = 0; index < 3; index += 1) {
            await expect(harness.read(`bogus-${String(index)}`)).rejects.toMatchObject({
                code: "instance_not_found",
            });
        }
        await expect(harness.start()).rejects.toMatchObject({
            code: "capacity_exhausted",
            retryable: true,
        });

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("preserves consumer-coded provider completions without degrading health", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "read") {
                harness.provider.complete(harness.registrationId, event.callId, {
                    error: {
                        code: "invalid_request",
                        message: "The requested file does not exist.",
                        retryable: false,
                    },
                });
                return;
            }
            harness.completeNormally(event);
        });

        for (let failure = 0; failure < 4; failure += 1) {
            await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
                code: "invalid_request",
                message: "The requested file does not exist.",
                retryable: false,
            });
        }
        expect(harness.registry.list()[0]?.health).toBe("healthy");
    });

    it("preserves provider capacity exhaustion as retryable without degrading health", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "read") {
                harness.provider.complete(harness.registrationId, event.callId, {
                    error: {
                        code: "capacity_exhausted",
                        message: "The compute service is temporarily at capacity.",
                        retryable: true,
                    },
                });
                return;
            }
            harness.completeNormally(event);
        });

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "capacity_exhausted",
            message: "The compute service is temporarily at capacity.",
            retryable: true,
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");
    });

    it("derives provider deadline retryability instead of trusting the provider", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        let failure = 0;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "read") {
                failure += 1;
                harness.provider.complete(harness.registrationId, event.callId, {
                    error: {
                        code: "deadline_exceeded",
                        message: `The provider timed out ${String(failure)}.`,
                        retryable: failure === 2,
                    },
                });
                return;
            }
            harness.completeNormally(event);
        });

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "deadline_exceeded",
            message: "The provider timed out 1.",
            retryable: true,
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "deadline_exceeded",
            message: "The provider timed out 2.",
            retryable: false,
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("counts malformed completions as provider failures", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "read") {
                expect(() =>
                    harness.provider.complete(harness.registrationId, event.callId, {
                        operation: "read",
                        result: {},
                    }),
                ).toThrow(expect.objectContaining({ code: "invalid_response" }));
                return;
            }
            harness.completeNormally(event);
        });

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("marks only a deadline against a still-healthy provider retryable", async () => {
        const harness = createHarness({ callTimeoutMs: 5 });
        const instance = await harness.start();
        harness.respond((event) => {
            if (event.type === "call" && event.operation !== "read") {
                harness.completeNormally(event);
            }
        });

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "deadline_exceeded",
            retryable: true,
        });
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "deadline_exceeded",
            retryable: false,
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("rejects in-flight calls immediately with provider_lost when the stream closes", async () => {
        const harness = createHarness({ callTimeoutMs: 60_000 });
        const instance = await harness.start();
        harness.respond((event) => {
            if (event.type === "call" && event.operation !== "read") {
                harness.completeNormally(event);
            }
        });
        const pending = harness.read(instance.instanceId);

        harness.detach();

        await expect(pending).rejects.toMatchObject({ code: "provider_lost" });
        expect(harness.registry.list()[0]?.health).toBe("failed");
    });

    it("unconditionally releases an instance when the provider stop handler fails", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "stop") {
                harness.provider.complete(harness.registrationId, event.callId, {
                    error: {
                        code: "invalid_response",
                        message: "The provider could not delete the instance.",
                        retryable: false,
                    },
                });
                return;
            }
            harness.completeNormally(event);
        });

        await expect(
            harness.registry.stop(instance.instanceId, harness.consumer.generation),
        ).resolves.toBeUndefined();
        await expect(
            Promise.resolve().then(() =>
                harness.registry.stop(instance.instanceId, harness.consumer.generation),
            ),
        ).rejects.toMatchObject({ code: "instance_not_found" });
    });

    it("reaps instances at their maximum lifetime and logs the reason", async () => {
        vi.useFakeTimers();
        const log = vi.fn();
        const harness = createHarness({
            idleTimeoutMs: 1_000,
            log,
            maxLifetimeMs: 50,
            reaperIntervalMs: 10,
        });
        const instance = await harness.start();

        await vi.advanceTimersByTimeAsync(50);
        await expect.poll(() => harness.stopCalls()).toBe(1);

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "instance_not_found",
        });
        expect(log).toHaveBeenCalledWith(
            "info",
            "plugin_compute_instance_reaped",
            "Rig automatically stopped an expired compute instance.",
            expect.objectContaining({ reason: "maximum lifetime of 50ms expired" }),
        );
    });

    it("refreshes idle activity on calls and reaps after the idle timeout", async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            idleTimeoutMs: 50,
            maxLifetimeMs: 1_000,
            reaperIntervalMs: 10,
        });
        const instance = await harness.start();

        await vi.advanceTimersByTimeAsync(40);
        await harness.read(instance.instanceId);
        await vi.advanceTimersByTimeAsync(40);
        expect(harness.stopCalls()).toBe(0);
        await vi.advanceTimersByTimeAsync(10);
        await expect.poll(() => harness.stopCalls()).toBe(1);
    });

    it("joins concurrent consumer stop and reaping without double notification or errors", async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            idleTimeoutMs: 10,
            maxLifetimeMs: 1_000,
            reaperIntervalMs: 10,
        });
        const instance = await harness.start();
        let stopEvent: Extract<HappyComputeEvent, { operation: "stop"; type: "call" }> | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "stop") {
                stopEvent = event;
                return;
            }
            harness.completeNormally(event);
        });

        await vi.advanceTimersByTimeAsync(10);
        expect(stopEvent).toBeDefined();
        const consumerStop = harness.registry.stop(
            instance.instanceId,
            harness.consumer.generation,
        );
        harness.provider.complete(harness.registrationId, stopEvent!.callId, {
            operation: "stop",
            result: {},
        });

        await expect(consumerStop).resolves.toBeUndefined();
        expect(harness.stopCalls()).toBe(1);
    });

    it("best-effort stops live instances during registry shutdown", async () => {
        const harness = createHarness();
        await harness.start();

        await harness.registry.close();

        expect(harness.stopCalls()).toBe(1);
    });

    it("reports voluntary provider unregistration as stopped", () => {
        const retired: unknown[] = [];
        const registry = track(new PluginComputeRegistry());
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
});

function createHarness(options: PluginComputeRegistryOptions = {}) {
    const registry = track(new PluginComputeRegistry(options));
    const provider = registry.createConnection({
        compute: { name: "local-bash" },
        folder: "local-bash",
        name: "Local Bash",
    });
    const consumer = registry.createConnection({ folder: "consumer", name: "Consumer" });
    const registrationId = provider.register();
    const events: HappyComputeEvent[] = [];
    let nextProviderInstance = 1;
    let responder: (event: HappyComputeEvent) => void = completeNormally;
    const detach = provider.attach(registrationId, (event) => {
        events.push(event);
        responder(event);
        return true;
    });

    function completeNormally(event: HappyComputeEvent): void {
        if (event.type !== "call") return;
        switch (event.operation) {
            case "start":
                provider.complete(registrationId, event.callId, {
                    operation: "start",
                    result: {
                        instanceId: `provider-instance-${String(nextProviderInstance++)}`,
                    },
                });
                break;
            case "read":
                provider.complete(registrationId, event.callId, {
                    operation: "read",
                    result: { bytes: 0, contentBase64: "" },
                });
                break;
            case "write":
                provider.complete(registrationId, event.callId, {
                    operation: "write",
                    result: {},
                });
                break;
            case "exec":
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
                break;
            case "stop":
                provider.complete(registrationId, event.callId, {
                    operation: "stop",
                    result: {},
                });
                break;
        }
    }

    return {
        completeNormally,
        consumer,
        detach,
        provider,
        read: (instanceId: string) =>
            registry.read({ instanceId, path: "message.txt" }, consumer.generation),
        registrationId,
        registry,
        respond(next: (event: HappyComputeEvent) => void) {
            responder = next;
        },
        respondNormally() {
            responder = completeNormally;
        },
        respondWithProviderError() {
            responder = (event) => {
                if (event.type === "call" && event.operation === "read") {
                    provider.complete(registrationId, event.callId, {
                        error: {
                            code: "invalid_response",
                            message: "The provider operation failed.",
                            retryable: false,
                        },
                    });
                    return;
                }
                completeNormally(event);
            };
        },
        start: () =>
            registry.start(
                {
                    provider: "local-bash",
                    workspaceSource: {
                        path: "/workspace/source",
                        type: "local_directory",
                    },
                },
                consumer.generation,
            ),
        stopCalls: () =>
            events.filter((event) => event.type === "call" && event.operation === "stop").length,
    };
}

function track(registry: PluginComputeRegistry): PluginComputeRegistry {
    registries.push(registry);
    return registry;
}
