import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    happyComputeErrorSchema,
    happyComputeInstanceSchema,
    happyComputePreparationEventSchema,
} from "../sources/computeTypes.js";
import { happyPluginManifestSchema } from "../sources/types.js";
import { HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS } from "../sources/types.js";

describe("happy plugin manifest", () => {
    it("validates compute readiness errors and terminal instance tombstones", () => {
        expect(
            Value.Check(happyComputeErrorSchema, {
                code: "preparing_compute",
                message: "The instance is still provisioning.",
                retryable: true,
                state: "provisioning",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputeErrorSchema, {
                code: "preparing_compute",
                message: "The instance failed.",
                retryable: true,
                state: "failed",
            }),
        ).toBe(false);
        expect(
            Value.Check(happyComputeInstanceSchema, {
                createdAt: 10,
                diedAt: 20,
                instanceId: "instance-1",
                provider: "test-compute",
                reason: "The provider crashed.",
                state: "failed",
            }),
        ).toBe(true);
    });

    it("validates typed compute preparation events", () => {
        expect(
            Value.Check(happyComputePreparationEventSchema, {
                createdAt: 10,
                error: {
                    code: "preparing_compute",
                    message: "The sandbox API rejected provisioning.",
                    retryable: true,
                    state: "unprovisioned",
                },
                instanceId: "instance-1",
                message: "The sandbox API rejected provisioning.",
                phase: "failed",
                provider: "test-compute",
                state: "unprovisioned",
                type: "compute_preparation",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputePreparationEventSchema, {
                createdAt: 20,
                error: {
                    code: "instance_failed",
                    message: "The compute provider disconnected.",
                    retryable: false,
                    state: "failed",
                },
                instanceId: "instance-1",
                message: "The compute provider disconnected.",
                phase: "failed",
                provider: "test-compute",
                state: "failed",
                type: "compute_preparation",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputePreparationEventSchema, {
                createdAt: 30,
                instanceId: "instance-1",
                message: "Compute preparation stopped.",
                phase: "stopped",
                provider: "test-compute",
                state: "stopped",
                type: "compute_preparation",
            }),
        ).toBe(true);
    });

    it("accepts Dockerfile and prebuilt-image runtime declarations", () => {
        const manifest = {
            description: "Runs in a container.",
            icon: "icon.png",
            main: "index.ts",
            name: "Docker fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, { ...manifest, docker: true })).toBe(true);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                docker: { image: "registry.example.com/plugins/fixture:1.0.0" },
            }),
        ).toBe(true);
        expect(Value.Check(happyPluginManifestSchema, { ...manifest, docker: false })).toBe(false);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                docker: { image: "invalid image", pull: true },
            }),
        ).toBe(false);
    });

    it("matches entry point extensions case-insensitively and rejects declarations", () => {
        const manifest = {
            description: "Tests the manifest entry point.",
            icon: "icon.png",
            main: "index.MJS",
            name: "Manifest fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, manifest)).toBe(true);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                main: "index.d.Ts",
            }),
        ).toBe(false);
    });

    it("accepts at most sixteen exact interception hostnames and rejects wildcards", () => {
        const manifest = {
            description: "Intercepts one exact API host.",
            icon: "icon.png",
            interceptDomains: ["api.example.com"],
            main: "index.ts",
            name: "Network fixture",
        };

        expect(Value.Check(happyPluginManifestSchema, manifest)).toBe(true);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                interceptDomains: ["*.example.com"],
            }),
        ).toBe(false);
        expect(
            Value.Check(happyPluginManifestSchema, {
                ...manifest,
                interceptDomains: Array.from(
                    { length: HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS + 1 },
                    (_, index) => `api-${String(index)}.example.com`,
                ),
            }),
        ).toBe(false);
    });
});
