import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCanaryVersion } from "./resolveCanaryVersion.js";

test("stays below every published release", () => {
    assert.equal(
        resolveCanaryVersion({ buildNumber: "41", commit: "0123456789abcdef" }),
        "0.0.0-canary.41.0123456",
    );
});

test("shortens and normalizes the commit", () => {
    assert.equal(
        resolveCanaryVersion({ buildNumber: "7", commit: "ABCDEF1234567" }),
        "0.0.0-canary.7.abcdef1",
    );
});

test("rejects a build number that is not a number", () => {
    assert.throws(
        () => resolveCanaryVersion({ buildNumber: "nightly", commit: "0123456789abcdef" }),
        /not a canary build number/,
    );
});

test("rejects a commit that is too short", () => {
    assert.throws(() => resolveCanaryVersion({ buildNumber: "1", commit: "abc" }), /not a commit/);
});
