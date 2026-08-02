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
        const instances = await Promise.all([harness.start(), harness.start(), harness.start()]);
        const failures: Extract<HappyComputeEvent, { operation: "read"; type: "call" }>[] = [];
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "read") failures.push(event);
            else harness.completeNormally(event);
        });
        const reads = instances.map((instance) => harness.read(instance.instanceId));
        await expect.poll(() => failures.length).toBe(3);

        harness.completeWithProviderError(failures[0]!);
        await expect(reads[0]).rejects.toMatchObject({
            code: "invalid_response",
            state: "ready",
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");

        harness.completeWithProviderError(failures[1]!);
        await expect(reads[1]).rejects.toMatchObject({
            code: "not_ready",
            retryable: true,
            state: "unavailable",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");

        harness.completeWithProviderError(failures[2]!);
        await expect(reads[2]).rejects.toMatchObject({
            code: "provider_lost",
            state: "failed",
        });
        expect(harness.registry.list()[0]?.health).toBe("failed");
        await expect(harness.read(instances[0]!.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
            state: "failed",
        });
        await expect(harness.read(instances[1]!.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
            state: "failed",
        });
        await expect(harness.start()).rejects.toMatchObject({
            code: "provider_unhealthy",
            retryable: false,
        });
    });

    it("resets consecutive failures and restores a degraded provider after a success", async () => {
        const harness = createHarness();
        const instances = await Promise.all([harness.start(), harness.start(), harness.start()]);
        const calls: Extract<HappyComputeEvent, { operation: "read"; type: "call" }>[] = [];
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "read") calls.push(event);
            else harness.completeNormally(event);
        });
        const reads = instances.map((instance) => harness.read(instance.instanceId));
        await expect.poll(() => calls.length).toBe(3);

        harness.completeWithProviderError(calls[0]!);
        await expect(reads[0]).rejects.toMatchObject({
            code: "invalid_response",
        });
        harness.completeWithProviderError(calls[1]!);
        await expect(reads[1]).rejects.toMatchObject({
            code: "not_ready",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");

        harness.completeNormally(calls[2]!);
        await expect(reads[2]).resolves.toMatchObject({
            contentBase64: "",
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ state: "ready" }),
                expect.objectContaining({ state: "ready" }),
                expect.objectContaining({ state: "ready" }),
            ]),
        );
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
            code: "not_ready",
            retryable: true,
            state: "unavailable",
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

    it("keeps provider deadline failures retryable across healthy and unavailable states", async () => {
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
                        retryable: true,
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
            retryable: true,
            state: "unavailable",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("probes an unavailable instance and restores it before retrying the operation", async () => {
        const harness = createHarness();
        const instance = await harness.start();
        harness.respondWithProviderError();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "invalid_response",
            state: "ready",
        });
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "not_ready",
            state: "unavailable",
        });

        harness.respondNormally();
        await expect(harness.read(instance.instanceId)).resolves.toMatchObject({
            contentBase64: "",
        });
        expect(harness.registry.list()[0]?.health).toBe("healthy");
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({ state: "ready" }),
        ]);
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
            code: "not_ready",
            retryable: true,
            state: "unavailable",
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
            retryable: true,
            state: "unavailable",
        });
        expect(harness.registry.list()[0]?.health).toBe("degraded");
    });

    it("waits for provisioning and maps exec and file operations to the same not_ready outcome", async () => {
        const harness = createHarness({ provisioningGraceMs: 5 });
        let startEvent:
            | Extract<HappyComputeEvent, { operation: "start"; type: "call" }>
            | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "start") {
                startEvent = event;
                return;
            }
            harness.completeNormally(event);
        });
        const starting = harness.start();
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation))
            .toEqual([expect.objectContaining({ state: "provisioning" })]);
        const provisioning = harness.registry.listInstances(harness.consumer.generation)[0]!;

        const operations = [
            harness.read(provisioning.instanceId),
            harness.registry.write(
                {
                    bytes: Buffer.from("updated"),
                    instanceId: provisioning.instanceId,
                    path: "message.txt",
                },
                harness.consumer.generation,
            ),
            harness.registry.exec(
                {
                    command: "true",
                    instanceId: provisioning.instanceId,
                    timeoutMs: 100,
                },
                harness.consumer.generation,
            ),
        ];
        for (const operation of operations) {
            await expect(operation).rejects.toMatchObject({
                code: "not_ready",
                retryable: true,
                state: "provisioning",
            });
        }

        harness.completeNormally(startEvent!);
        await expect(starting).resolves.toMatchObject({ state: "ready" });
    });

    it("does not resolve start until the materialized instance passes its readiness probe", async () => {
        const harness = createHarness();
        let probe: Extract<HappyComputeEvent, { operation: "exec"; type: "call" }> | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "exec" && event.command === "true") {
                probe = event;
                return;
            }
            harness.completeNormally(event);
        });
        const starting = harness.start();

        await expect.poll(() => probe).toBeDefined();
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({ state: "provisioning" }),
        ]);
        harness.completeNormally(probe!);

        await expect(starting).resolves.toMatchObject({
            provider: "local-bash",
            state: "ready",
        });
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({ state: "ready" }),
        ]);
    });

    it("returns the stopped tombstone when consumer stop wins an in-flight readiness probe", async () => {
        const harness = createHarness();
        let probe: Extract<HappyComputeEvent, { operation: "exec"; type: "call" }> | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "exec" && event.command === "true") {
                probe = event;
                return;
            }
            harness.completeNormally(event);
        });
        const starting = harness.start();
        await expect.poll(() => probe).toBeDefined();
        const provisioning = harness.registry.listInstances(harness.consumer.generation)[0]!;

        await harness.registry.stop(provisioning.instanceId, harness.consumer.generation);
        harness.completeNormally(probe!);

        await expect(starting).rejects.toMatchObject({
            code: "instance_failed",
            message: "stopped at its consumer's request",
            retryable: false,
            state: "stopped",
        });
    });

    it("returns the stopped tombstone when consumer release wins an in-flight readiness probe", async () => {
        const harness = createHarness();
        let probe: Extract<HappyComputeEvent, { operation: "exec"; type: "call" }> | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "exec" && event.command === "true") {
                probe = event;
                return;
            }
            harness.completeNormally(event);
        });
        const starting = harness.start();
        await expect.poll(() => probe).toBeDefined();

        harness.consumer.close();
        harness.completeNormally(probe!);

        await expect(starting).rejects.toMatchObject({
            code: "instance_failed",
            message: "its consumer plugin stopped",
            retryable: false,
            state: "stopped",
        });
    });

    it("returns the failed tombstone when reaping wins an in-flight readiness probe", async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            idleTimeoutMs: 1_000,
            maxLifetimeMs: 10,
            reaperIntervalMs: 10,
        });
        let probe: Extract<HappyComputeEvent, { operation: "exec"; type: "call" }> | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "exec" && event.command === "true") {
                probe = event;
                return;
            }
            harness.completeNormally(event);
        });
        const starting = harness.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(probe).toBeDefined();

        await vi.advanceTimersByTimeAsync(10);
        harness.completeNormally(probe!);

        await expect(starting).rejects.toMatchObject({
            code: "instance_failed",
            message: expect.stringContaining("maximum lifetime"),
            retryable: false,
            state: "failed",
        });
    });

    it("moves a materialized instance to unavailable after a rejected probe and recovers it", async () => {
        vi.useFakeTimers();
        const harness = createHarness({ callTimeoutMs: 10, provisioningGraceMs: 10 });
        let initialProbe:
            | Extract<HappyComputeEvent, { operation: "exec"; type: "call" }>
            | undefined;
        harness.respond((event) => {
            if (
                event.type === "call" &&
                event.operation === "exec" &&
                event.command === "true" &&
                initialProbe === undefined
            ) {
                initialProbe = event;
                return;
            }
            harness.completeNormally(event);
        });
        const starting = harness.start();
        const startFailure = expect(starting).rejects.toMatchObject({
            code: "not_ready",
            message: expect.stringContaining("readiness probe could not complete"),
            retryable: true,
            state: "unavailable",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(initialProbe).toBeDefined();
        const provisioning = harness.registry.listInstances(harness.consumer.generation)[0]!;

        await vi.advanceTimersByTimeAsync(10);
        await startFailure;
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({
                instanceId: provisioning.instanceId,
                state: "unavailable",
            }),
        ]);

        await expect(harness.read(provisioning.instanceId)).resolves.toMatchObject({
            contentBase64: "",
        });
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({
                instanceId: provisioning.instanceId,
                state: "ready",
            }),
        ]);
    });

    it("returns bounded tombstones for dead instances and not_found after eviction", async () => {
        const harness = createHarness({ maxTombstones: 1 });
        const first = await harness.start();
        await harness.registry.stop(first.instanceId, harness.consumer.generation);

        await expect(harness.read(first.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
            message: "stopped at its consumer's request",
            retryable: false,
            state: "stopped",
        });
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({
                diedAt: expect.any(Number),
                instanceId: first.instanceId,
                state: "stopped",
            }),
        ]);

        const second = await harness.start();
        await harness.registry.stop(second.instanceId, harness.consumer.generation);
        await expect(harness.read(first.instanceId)).rejects.toMatchObject({
            code: "instance_not_found",
        });
        await expect(harness.read("never-existed")).rejects.toMatchObject({
            code: "instance_not_found",
        });
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

        await expect(pending).rejects.toMatchObject({
            code: "provider_lost",
            retryable: false,
            state: "failed",
        });
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
        ).rejects.toMatchObject({
            code: "instance_failed",
            state: "stopped",
        });
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
            code: "instance_failed",
            message: expect.stringContaining("maximum lifetime"),
            state: "failed",
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
        completeWithProviderError(
            event: Extract<HappyComputeEvent, { operation: "read"; type: "call" }>,
        ) {
            provider.complete(registrationId, event.callId, {
                error: {
                    code: "invalid_response",
                    message: "The provider operation failed.",
                    retryable: false,
                },
            });
        },
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
