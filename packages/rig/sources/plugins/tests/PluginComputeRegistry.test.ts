import { afterEach, describe, expect, it, vi } from "vitest";

import type { HappyComputeEvent } from "happy-plugins/internal";

import {
    PluginComputeRegistry,
    type PluginComputeRegistryEvent,
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
            code: "preparing_compute",
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
        const offline = harness.create();
        expect(offline.state).toBe("unprovisioned");
        await expect(harness.read(offline.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
            retryable: true,
            state: "provisioning",
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
            code: "preparing_compute",
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
            code: "preparing_compute",
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
            code: "preparing_compute",
            state: "unavailable",
        });

        harness.respondNormally();
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
            state: "unavailable",
        });
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation)[0]?.state)
            .toBe("ready");
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
            code: "preparing_compute",
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

    it("creates offline metadata without contacting a provider", async () => {
        const harness = createHarness();
        const instance = harness.create("offline-compute");

        expect(instance.state).toBe("unprovisioned");
        expect(harness.startCalls()).toBe(0);
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({
                instanceId: instance.instanceId,
                provider: "offline-compute",
                state: "unprovisioned",
            }),
        ]);

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
            retryable: true,
            state: "provisioning",
        });
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation))
            .toEqual([
                expect.objectContaining({
                    instanceId: instance.instanceId,
                    reason: expect.stringContaining("No running compute provider"),
                    state: "unprovisioned",
                }),
            ]);
        expect(harness.startCalls()).toBe(0);
    });

    it("fails concurrent first uses fast, provisions once, and emits ordered phases", async () => {
        const harness = createHarness();
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
        const instance = harness.create();

        const operations = [
            harness.read(instance.instanceId),
            harness.registry.write(
                {
                    bytes: Buffer.from("updated"),
                    instanceId: instance.instanceId,
                    path: "message.txt",
                },
                harness.consumer.generation,
            ),
            harness.registry.exec(
                {
                    command: "true",
                    instanceId: instance.instanceId,
                    timeoutMs: 100,
                },
                harness.consumer.generation,
            ),
        ];
        for (const operation of operations) {
            await expect(operation).rejects.toMatchObject({
                code: "preparing_compute",
                retryable: true,
                state: "provisioning",
            });
        }
        await expect.poll(() => startEvent).toBeDefined();
        expect(harness.startCalls()).toBe(1);
        harness.provider.progress(harness.registrationId, startEvent!.callId, {
            message: "Checking out code.",
            phase: "checking_out_code",
        });
        harness.provider.progress(harness.registrationId, startEvent!.callId, {
            message: "Copying files to compute.",
            phase: "copying_files_to_compute",
        });
        harness.completeStart(startEvent!);
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation)[0]?.state)
            .toBe("ready");
        expect(
            harness.registryEvents
                .filter((event) => event.type === "preparation")
                .map((event) => event.phase),
        ).toEqual([
            "preparing_compute",
            "checking_out_code",
            "copying_files_to_compute",
            "verifying_compute",
            "ready",
        ]);
    });

    it("emits one terminal event when compute is stopped during provisioning", async () => {
        const harness = createHarness();
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
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
        });
        await expect.poll(() => startEvent).toBeDefined();
        await harness.registry.stop(instance.instanceId, harness.consumer.generation);

        const stoppedEvents = harness.registryEvents.filter(
            (event) =>
                event.type === "preparation" &&
                event.instanceId === instance.instanceId &&
                event.phase === "stopped",
        );
        expect(stoppedEvents).toEqual([expect.objectContaining({ state: "stopped" })]);
        expect(stoppedEvents[0]).not.toHaveProperty("error");

        harness.completeNormally(startEvent!);
        await expect.poll(() => harness.stopCalls()).toBe(1);
        expect(
            harness.registryEvents.filter(
                (event) =>
                    event.type === "preparation" &&
                    event.instanceId === instance.instanceId &&
                    event.phase === "stopped",
            ),
        ).toHaveLength(1);
    });

    it("emits a failed event when the provider dies during readiness verification", async () => {
        const harness = createHarness();
        let probe: Extract<HappyComputeEvent, { operation: "exec"; type: "call" }> | undefined;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "exec" && event.command === "true") {
                probe = event;
                return;
            }
            harness.completeNormally(event);
        });
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
        });
        await expect.poll(() => probe).toBeDefined();
        harness.detach();

        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation)[0])
            .toMatchObject({ state: "failed" });
        expect(
            harness.registryEvents.filter(
                (event) =>
                    event.type === "preparation" &&
                    event.instanceId === instance.instanceId &&
                    event.phase === "failed",
            ),
        ).toEqual([
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "instance_failed",
                    retryable: false,
                    state: "failed",
                }),
                message: expect.stringContaining("provider crashed or disconnected"),
                state: "failed",
            }),
        ]);
    });

    it("emits one closing event when shutdown interrupts provisioning", async () => {
        const harness = createHarness();
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
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
        });
        await expect.poll(() => startEvent).toBeDefined();
        await harness.registry.close();

        expect(
            harness.registryEvents.filter(
                (event) =>
                    event.type === "preparation" &&
                    event.instanceId === instance.instanceId &&
                    event.phase === "stopped",
            ),
        ).toEqual([
            expect.objectContaining({
                message: expect.stringContaining("Rig shut down"),
                state: "stopped",
            }),
        ]);
    });

    it("allows provisioning to continue beyond the old thirty-second deadline", async () => {
        vi.useFakeTimers();
        const harness = createHarness();
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
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(startEvent).toBeDefined();
        harness.provider.progress(harness.registrationId, startEvent!.callId, {
            message: "Checking out code.",
            phase: "checking_out_code",
        });
        harness.provider.progress(harness.registrationId, startEvent!.callId, {
            message: "Copying files to compute.",
            phase: "copying_files_to_compute",
        });

        await vi.advanceTimersByTimeAsync(31_000);

        expect(harness.registry.list()[0]?.health).toBe("healthy");
        expect(harness.registry.listInstances(harness.consumer.generation)[0]?.state).toBe(
            "provisioning",
        );
        harness.completeStart(startEvent!);
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.registry.listInstances(harness.consumer.generation)[0]?.state).toBe("ready");
    });

    it("does not degrade provider health when the provisioning budget expires", async () => {
        vi.useFakeTimers();
        const harness = createHarness({ provisionDeadlineMs: 20 });
        harness.respond((event) => {
            if (event.type === "call" && event.operation !== "start") {
                harness.completeNormally(event);
            }
        });
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
        });
        await vi.advanceTimersByTimeAsync(20);

        expect(harness.registry.list()[0]?.health).toBe("healthy");
        expect(harness.registry.listInstances(harness.consumer.generation)[0]).toMatchObject({
            reason: expect.stringContaining("provisioning exceeded its 20ms budget"),
            state: "unprovisioned",
        });
        expect(
            harness.registryEvents.find(
                (event) =>
                    event.type === "preparation" &&
                    event.instanceId === instance.instanceId &&
                    event.phase === "failed",
            ),
        ).toMatchObject({
            error: {
                code: "preparing_compute",
                retryable: true,
                state: "unprovisioned",
            },
            state: "unprovisioned",
        });
    });

    it("rejects provisioning that omits required materialization phases", async () => {
        const harness = createHarness();
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "start") {
                harness.completeStart(event);
                return;
            }
            harness.completeNormally(event);
        });
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
            state: "provisioning",
        });
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation)[0])
            .toMatchObject({
                reason: expect.stringContaining(
                    "without reporting its checkout and file-copy phases",
                ),
                state: "unprovisioned",
            });
        await expect.poll(() => harness.stopCalls()).toBe(1);
        expect(
            harness.registryEvents
                .filter((event) => event.type === "preparation")
                .map((event) => event.phase),
        ).toEqual(["preparing_compute", "failed"]);
    });

    it("resets failed provisioning to unprovisioned and retries successfully", async () => {
        const harness = createHarness();
        let attempt = 0;
        harness.respond((event) => {
            if (event.type === "call" && event.operation === "start") {
                attempt += 1;
                if (attempt === 1) {
                    harness.provider.complete(harness.registrationId, event.callId, {
                        error: {
                            code: "invalid_response",
                            message: "The cloud sandbox failed to start.",
                            retryable: false,
                        },
                    });
                    return;
                }
            }
            harness.completeNormally(event);
        });
        const instance = harness.create();

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
            state: "provisioning",
        });
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation)[0])
            .toMatchObject({
                reason: expect.stringContaining("cloud sandbox failed to start"),
                state: "unprovisioned",
            });
        expect(
            harness.registryEvents.find(
                (event) => event.type === "preparation" && event.phase === "failed",
            ),
        ).toMatchObject({
            error: {
                code: "preparing_compute",
                retryable: true,
                state: "unprovisioned",
            },
            message: expect.stringContaining("cloud sandbox failed to start"),
            state: "unprovisioned",
        });

        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "preparing_compute",
            state: "provisioning",
        });
        await expect
            .poll(() => harness.registry.listInstances(harness.consumer.generation)[0]?.state)
            .toBe("ready");
        expect(harness.startCalls()).toBe(2);
        await expect(harness.read(instance.instanceId)).resolves.toMatchObject({
            contentBase64: "",
        });
    });

    it("returns bounded tombstones for dead instances and not_found after eviction", async () => {
        const harness = createHarness({ maxTombstones: 1 });
        const first = await harness.start();
        await harness.registry.stop(first.instanceId, harness.consumer.generation);

        await expect(harness.read(first.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
            message: "The compute instance was stopped at its consumer's request.",
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

    it("reaps unprovisioned handles at their lifetime bound with a tombstone and event", async () => {
        vi.useFakeTimers();
        const harness = createHarness({
            idleTimeoutMs: 10,
            maxLifetimeMs: 10,
            reaperIntervalMs: 10,
        });
        const instance = harness.create();

        await vi.advanceTimersByTimeAsync(10);

        expect(harness.stopCalls()).toBe(0);
        expect(harness.registry.listInstances(harness.consumer.generation)).toEqual([
            expect.objectContaining({
                diedAt: expect.any(Number),
                instanceId: instance.instanceId,
                reason: expect.stringContaining("maximum unprovisioned lifetime"),
                state: "failed",
            }),
        ]);
        await expect(harness.read(instance.instanceId)).rejects.toMatchObject({
            code: "instance_failed",
            state: "failed",
        });
        expect(
            harness.registryEvents.filter(
                (event) =>
                    event.type === "preparation" &&
                    event.instanceId === instance.instanceId &&
                    event.phase === "failed",
            ),
        ).toEqual([
            expect.objectContaining({
                error: expect.objectContaining({
                    code: "instance_failed",
                    state: "failed",
                }),
                state: "failed",
            }),
        ]);
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
    const registryEvents: PluginComputeRegistryEvent[] = [];
    registry.subscribe((event) => registryEvents.push(event));
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

    function completeStart(
        event: Extract<HappyComputeEvent, { operation: "start"; type: "call" }>,
    ): void {
        provider.complete(registrationId, event.callId, {
            operation: "start",
            result: {
                instanceId: `provider-instance-${String(nextProviderInstance++)}`,
            },
        });
    }

    function completeNormally(event: HappyComputeEvent): void {
        if (event.type !== "call") return;
        switch (event.operation) {
            case "start":
                provider.progress(registrationId, event.callId, {
                    message: "Checking out code.",
                    phase: "checking_out_code",
                });
                provider.progress(registrationId, event.callId, {
                    message: "Copying files to compute.",
                    phase: "copying_files_to_compute",
                });
                completeStart(event);
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

    const create = (providerName = "local-bash") =>
        registry.create(
            {
                provider: providerName,
                workspaceSource: {
                    path: "/workspace/source",
                    type: "local_directory",
                },
            },
            consumer.generation,
        );
    const start = async () => {
        const instance = create();
        await expect(
            registry.read(
                { instanceId: instance.instanceId, path: "message.txt" },
                consumer.generation,
            ),
        ).rejects.toMatchObject({
            code: "preparing_compute",
            state: "provisioning",
        });
        await expect
            .poll(() =>
                registry
                    .listInstances(consumer.generation)
                    .find((candidate) => candidate.instanceId === instance.instanceId),
            )
            .toMatchObject({ state: "ready" });
        return registry
            .listInstances(consumer.generation)
            .find((candidate) => candidate.instanceId === instance.instanceId)!;
    };

    return {
        completeNormally,
        completeStart,
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
        create,
        detach,
        provider,
        read: (instanceId: string) =>
            registry.read({ instanceId, path: "message.txt" }, consumer.generation),
        registrationId,
        registry,
        registryEvents,
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
        start,
        startCalls: () =>
            events.filter((event) => event.type === "call" && event.operation === "start").length,
        stopCalls: () =>
            events.filter((event) => event.type === "call" && event.operation === "stop").length,
    };
}

function track(registry: PluginComputeRegistry): PluginComputeRegistry {
    registries.push(registry);
    return registry;
}
