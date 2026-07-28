import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveReleasePackage } from "./resolveReleasePackage.js";

describe("resolveReleasePackage", () => {
    it("keeps Rig as the default release target", () => {
        const target = resolveReleasePackage(undefined);

        assert.equal(target.key, "rig");
        assert.equal(target.tagPrefix, "v");
    });

    it("gives rig-connect its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("rig-connect");

        assert.equal(target.key, "rig-connect");
        assert.equal(target.tagPrefix, "rig-connect-v");
        assert.match(target.directory, /packages\/rig-connect\/?$/u);
    });

    it("rejects a target that could publish an unintended workspace package", () => {
        assert.throws(() => resolveReleasePackage("other"), /Unknown release package other/u);
    });
});
