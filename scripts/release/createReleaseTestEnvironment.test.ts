import assert from "node:assert/strict";
import { test } from "node:test";

import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";

test("removes the release runner's temporary directory without mutating its environment", () => {
    const environment = {
        PATH: "/usr/bin",
        TMPDIR: "/workspace/.local",
    };

    assert.deepEqual(createReleaseTestEnvironment(environment), {
        PATH: "/usr/bin",
    });
    assert.equal(environment.TMPDIR, "/workspace/.local");
});
