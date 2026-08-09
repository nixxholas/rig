import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";
import type { ReleasePackage } from "./ReleasePackage.js";
import { runCommand } from "./runCommand.js";

export function validateRelease(
    releasePackage: ReleasePackage,
    options: { tests?: boolean } = {},
    run: typeof runCommand = runCommand,
): void {
    run("pnpm", ["install", "--frozen-lockfile"], {
        environment: { ...process.env, CI: "true" },
    });
    run("pnpm", ["run", "check"]);
    if (options.tests !== false) {
        run("pnpm", ["run", "test:release"], {
            environment: createReleaseTestEnvironment(),
        });
    }
    run("pnpm", releasePackage.buildArguments);
}
