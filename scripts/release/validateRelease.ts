import type { ReleasePackage } from "./ReleasePackage.js";
import { runCommand } from "./runCommand.js";
import { runReleasePackageValidation } from "./runReleasePackageValidation.js";

export function validateRelease(
    releasePackage: ReleasePackage,
    options: { tests?: boolean } = {},
    run: typeof runCommand = runCommand,
): void {
    run("pnpm", ["install", "--frozen-lockfile"], {
        environment: { ...process.env, CI: "true" },
    });
    runReleasePackageValidation(releasePackage, "check", run);
    if (options.tests !== false) {
        runReleasePackageValidation(releasePackage, "test", run);
    }
    run("pnpm", releasePackage.buildArguments);
}
