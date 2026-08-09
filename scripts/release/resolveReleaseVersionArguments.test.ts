import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveReleaseVersionArguments } from "./resolveReleaseVersionArguments.js";

describe("resolveReleaseVersionArguments", () => {
    it("starts a beta at the next patch", () => {
        assert.deepEqual(resolveReleaseVersionArguments("0.0.164", "beta"), {
            arguments: ["prepatch", "--preid", "beta", "--no-git-tag-version"],
            beta: true,
        });
    });

    it("advances an existing beta", () => {
        assert.deepEqual(resolveReleaseVersionArguments("0.0.165-beta.0", "beta"), {
            arguments: ["prerelease", "--preid", "beta", "--no-git-tag-version"],
            beta: true,
        });
    });

    it("keeps ordinary release bumps unchanged", () => {
        assert.deepEqual(resolveReleaseVersionArguments("0.0.164", "patch"), {
            arguments: ["patch", "--no-git-tag-version"],
            beta: false,
        });
    });

    it("recognizes an explicit beta version", () => {
        assert.equal(resolveReleaseVersionArguments("0.0.164", "0.0.165-beta.0").beta, true);
    });

    it("does not mix beta numbering into another prerelease channel", () => {
        assert.throws(
            () => resolveReleaseVersionArguments("0.0.165-preview.0", "beta"),
            /cannot follow/u,
        );
    });
});
