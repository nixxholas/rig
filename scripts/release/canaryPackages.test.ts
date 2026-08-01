import assert from "node:assert/strict";
import { test } from "node:test";

import { CANARY_PACKAGES } from "./CanaryPackages.js";

test("checks both side packages by their published npm names", () => {
    assert.deepEqual(CANARY_PACKAGES, [
        {
            npmName: "happy-plugins",
            output: "plugins",
            path: "packages/happy-plugins",
        },
        {
            npmName: "@slopus/rig-connect",
            output: "connect",
            path: "packages/rig-connect",
        },
    ]);
});
