import type { ReleaseValidationOperation } from "./release/runReleasePackageValidation.js";
import { runReleasePackageValidation } from "./release/runReleasePackageValidation.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";

const operation = process.argv[2];
if (operation !== "check" && operation !== "test") {
    throw new Error("Expected release validation operation check or test.");
}

runReleasePackageValidation(
    resolveReleasePackage(process.env.RELEASE_PACKAGE),
    operation satisfies ReleaseValidationOperation,
);
