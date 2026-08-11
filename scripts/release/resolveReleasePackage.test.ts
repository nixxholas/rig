import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { resolveReleasePackage } from "./resolveReleasePackage.js";

describe("resolveReleasePackage", () => {
    it("keeps Rig as the default release target", () => {
        const target = resolveReleasePackage(undefined);

        assert.equal(target.key, "rig");
        assert.equal(target.tagPrefix, "v");
        assert.deepEqual(target.testArguments, [["run", "test:release"]]);
        const rootManifest = JSON.parse(
            readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ) as { scripts: Record<string, string> };
        assert.match(
            rootManifest.scripts["test:release"] ?? "",
            /--filter '!@slopus\/happy-providers'/u,
        );
        assert.match(rootManifest.scripts["test:release"] ?? "", /--filter '!happy-plugins'/u);
        assert.match(
            rootManifest.scripts["test:release"] ?? "",
            /--filter '!@slopus\/rig-codemode-codex'/u,
        );
    });

    it("gives rig-connect its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("rig-connect");

        assert.equal(target.key, "rig-connect");
        assert.equal(target.tagPrefix, "rig-connect-v");
        assert.match(target.directory, /packages\/rig-connect\/?$/u);
    });

    it("gives happy-plugins its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("happy-plugins");

        assert.equal(target.key, "happy-plugins");
        assert.equal(target.tagPrefix, "happy-plugins-v");
        assert.match(target.directory, /packages\/happy-plugins\/?$/u);
        assert.deepEqual(target.buildArguments, ["--filter", "happy-plugins", "build"]);
    });

    it("gives happy-providers its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("happy-providers");

        assert.equal(target.key, "happy-providers");
        assert.equal(target.tagPrefix, "happy-providers-v");
        assert.match(target.directory, /packages\/happy-providers\/?$/u);
        assert.deepEqual(target.buildArguments, ["--filter", "@slopus/happy-providers", "build"]);
        assert.deepEqual(target.checkArguments, ["--filter", "@slopus/happy-providers", "check"]);
        assert.deepEqual(target.testArguments, [
            ["run", "test:scripts"],
            ["--filter", "@slopus/happy-providers", "test"],
        ]);
    });

    it("rejects a target that could publish an unintended workspace package", () => {
        assert.throws(() => resolveReleasePackage("other"), /Unknown release package other/u);
    });
});
