import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertBundledHappyRuntimeDependencies } from "./assertBundledHappyRuntimeDependencies.js";

const bundled = {
    "@slopus/happy-agent": "workspace:*",
    "@slopus/happy-agent-modules": "workspace:*",
};

describe("assertBundledHappyRuntimeDependencies", () => {
    it("accepts unpublished Happy workspaces as build-only inputs", () => {
        assert.doesNotThrow(() =>
            assertBundledHappyRuntimeDependencies({
                devDependencies: bundled,
                name: "@slopus/rig",
                version: "1.2.3",
            }),
        );
    });

    it("rejects an npm dependency on an unpublished Happy workspace", () => {
        assert.throws(
            () =>
                assertBundledHappyRuntimeDependencies({
                    dependencies: { "@slopus/happy-agent": "0.0.0" },
                    devDependencies: bundled,
                    name: "@slopus/rig",
                    version: "1.2.3",
                }),
            /must bundle unpublished Happy workspaces/u,
        );
    });

    it("rejects a missing build input", () => {
        assert.throws(
            () =>
                assertBundledHappyRuntimeDependencies({
                    devDependencies: { "@slopus/happy-agent": "workspace:*" },
                    name: "@slopus/rig",
                    version: "1.2.3",
                }),
            /missing bundled Happy build inputs/u,
        );
    });
});