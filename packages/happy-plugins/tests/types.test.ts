import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { happyPluginManifestSchema } from "../sources/types.js";

describe("happy plugin manifest", () => {
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
});
