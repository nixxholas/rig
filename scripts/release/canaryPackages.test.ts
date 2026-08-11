import assert from "node:assert/strict";
import { test } from "node:test";

import { CANARY_PACKAGES } from "./CanaryPackages.js";

test("checks every side package by its published npm name", () => {
    assert.deepEqual(CANARY_PACKAGES, [
        {
            npmName: "@slopus/happy-providers",
            output: "providers",
            path: "packages/happy-providers",
        },
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
