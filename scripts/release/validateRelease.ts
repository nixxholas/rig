import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";
import type { ReleasePackage } from "./ReleasePackage.js";
import { runCommand } from "./runCommand.js";

export function validateRelease(
    releasePackage: ReleasePackage,
    run: typeof runCommand = runCommand,
): void {
    run("pnpm", ["install", "--frozen-lockfile"], {
        environment: { ...process.env, CI: "true" },
    });
    run("pnpm", ["run", "check"]);
    run("pnpm", ["test"], {
        environment: createReleaseTestEnvironment(),
    });
    run("pnpm", releasePackage.buildArguments);
}
