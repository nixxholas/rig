import assert from "node:assert/strict";
import { test } from "node:test";

import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";
import type { ReleasePackage } from "./ReleasePackage.js";
import { validateRelease } from "./validateRelease.js";

const RELEASE_PACKAGE: ReleasePackage = {
    buildArguments: ["--filter", "happy-plugins", "build"],
    checkArguments: ["--filter", "happy-plugins", "check"],
    commitPrefix: "Release happy-plugins v",
    directory: "/workspace/packages/happy-plugins",
    key: "happy-plugins",
    manifestPath: "packages/happy-plugins/package.json",
    tagPrefix: "happy-plugins-v",
    testArguments: [
        ["run", "test:scripts"],
        ["--filter", "happy-plugins", "test"],
    ],
};

test("synchronizes the frozen workspace install before release validation", () => {
    const commands: Array<{
        arguments_: readonly string[];
        command: string;
        environment: NodeJS.ProcessEnv | undefined;
    }> = [];

    validateRelease(RELEASE_PACKAGE, {}, (command, arguments_, options) => {
        commands.push({ arguments_, command, environment: options?.environment });
        return { status: 0, stderr: "", stdout: "" };
    });

    assert.deepEqual(
        commands.map(({ arguments_, command }) => ({ arguments_, command })),
        [
            {
                arguments_: ["install", "--frozen-lockfile"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "happy-plugins", "check"],
                command: "pnpm",
            },
            {
                arguments_: ["run", "test:scripts"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "happy-plugins", "test"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "happy-plugins", "build"],
                command: "pnpm",
            },
        ],
    );
    assert.equal(commands[0]?.environment?.CI, "true");
    assert.deepEqual(commands[2]?.environment, createReleaseTestEnvironment());
    assert.deepEqual(commands[3]?.environment, createReleaseTestEnvironment());
});

test("a beta release typechecks and builds without running tests", () => {
    const commands: Array<{ arguments_: readonly string[]; command: string }> = [];

    validateRelease(RELEASE_PACKAGE, { tests: false }, (command, arguments_) => {
        commands.push({ arguments_, command });
        return { status: 0, stderr: "", stdout: "" };
    });

    assert.deepEqual(commands, [
        { arguments_: ["install", "--frozen-lockfile"], command: "pnpm" },
        { arguments_: ["--filter", "happy-plugins", "check"], command: "pnpm" },
        { arguments_: ["--filter", "happy-plugins", "build"], command: "pnpm" },
    ]);
});
