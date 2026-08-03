import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReleasePackage } from "./ReleasePackage.js";
import { validateRelease } from "./validateRelease.js";

const RELEASE_PACKAGE: ReleasePackage = {
    buildArguments: ["--filter", "happy-plugins", "build"],
    commitPrefix: "Release happy-plugins v",
    directory: "/workspace/packages/happy-plugins",
    key: "happy-plugins",
    manifestPath: "packages/happy-plugins/package.json",
    tagPrefix: "happy-plugins-v",
};

test("synchronizes the frozen workspace install before release validation", () => {
    const commands: Array<{
        arguments_: readonly string[];
        command: string;
        environment: NodeJS.ProcessEnv | undefined;
    }> = [];

    validateRelease(RELEASE_PACKAGE, (command, arguments_, options) => {
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
                arguments_: ["run", "check"],
                command: "pnpm",
            },
            {
                arguments_: ["test"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "happy-plugins", "build"],
                command: "pnpm",
            },
        ],
    );
    assert.equal(commands[0]?.environment?.CI, "true");
});
