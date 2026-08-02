import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { happyComputeErrorSchema, happyComputeInstanceSchema } from "../sources/computeTypes.js";
import { happyPluginManifestSchema } from "../sources/types.js";
import { HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS } from "../sources/types.js";

describe("happy plugin manifest", () => {
    it("validates compute readiness errors and terminal instance tombstones", () => {
        expect(
            Value.Check(happyComputeErrorSchema, {
                code: "not_ready",
                message: "The instance is still provisioning.",
                retryable: true,
                state: "provisioning",
            }),
        ).toBe(true);
        expect(
            Value.Check(happyComputeErrorSchema, {
                code: "not_ready",
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
