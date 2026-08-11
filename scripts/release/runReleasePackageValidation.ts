import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";
import type { ReleasePackage } from "./ReleasePackage.js";
import { runCommand } from "./runCommand.js";

export type ReleaseValidationOperation = "check" | "test";

export function runReleasePackageValidation(
    releasePackage: ReleasePackage,
    operation: ReleaseValidationOperation,
    run: typeof runCommand = runCommand,
): void {
    const commands =
        operation === "check" ? [releasePackage.checkArguments] : releasePackage.testArguments;
    for (const arguments_ of commands) {
        run("pnpm", arguments_, {
            ...(operation === "test" ? { environment: createReleaseTestEnvironment() } : {}),
        });
    }
}
