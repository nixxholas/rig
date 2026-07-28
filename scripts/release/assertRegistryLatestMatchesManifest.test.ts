import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertRegistryLatestMatchesManifest } from "./assertRegistryLatestMatchesManifest.js";

const MANIFEST = { name: "@slopus/rig-connect", version: "0.0.5" };

describe("assertRegistryLatestMatchesManifest", () => {
    it("accepts a worktree aligned with npm latest", () => {
        assert.doesNotThrow(() => assertRegistryLatestMatchesManifest(MANIFEST, '"0.0.5"'));
    });

    it("rejects version drift before another release can hide it", () => {
        assert.throws(
            () => assertRegistryLatestMatchesManifest(MANIFEST, '"0.0.6"'),
            /worktree but npm latest is 0\.0\.6/u,
        );
    });
});
