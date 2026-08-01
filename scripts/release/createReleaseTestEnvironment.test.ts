import assert from "node:assert/strict";
import { test } from "node:test";

import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";

test("moves release tests out of the workspace without mutating the runner environment", () => {
    const environment = {
        PATH: "/usr/bin",
        TMPDIR: "/workspace/.local",
    };

    assert.deepEqual(createReleaseTestEnvironment(environment), {
        PATH: "/usr/bin",
        TMPDIR: "/tmp",
    });
    assert.equal(environment.TMPDIR, "/workspace/.local");
});
