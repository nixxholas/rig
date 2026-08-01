import { appendFileSync } from "node:fs";

import { CANARY_PACKAGES } from "./release/CanaryPackages.js";
import { resolveCanaryPackageChange } from "./release/resolveCanaryPackageChange.js";
import { runCommand } from "./release/runCommand.js";

function resolveCommit(reference: string): string | undefined {
    const result = runCommand("git", ["rev-parse", "--verify", `${reference}^{commit}`], {
        allowFailure: true,
        captureOutput: true,
    });
    return result.status === 0 ? result.stdout : undefined;
}

function resolveFallbackBase(pushedFrom: string | undefined): string {
    const pushedFromCommit =
        pushedFrom === undefined || pushedFrom.trim().length === 0
            ? undefined
            : resolveCommit(pushedFrom.trim());
    const fallbackBase = pushedFromCommit ?? resolveCommit("HEAD~1");
    if (fallbackBase === undefined) {
        throw new Error("Could not resolve the pushed-from commit or HEAD~1.");
    }
    return fallbackBase;
}

function hasChanges(base: string, packagePath: string): boolean {
    const result = runCommand("git", ["diff", "--quiet", base, "HEAD", "--", packagePath], {
        allowFailure: true,
        captureOutput: true,
    });
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`Could not compare ${packagePath} with ${base}.`);
    }
    return result.status === 1;
}

function readPublishedCanary(npmName: string): string | undefined {
    const result = runCommand("pnpm", ["view", npmName, "dist-tags.canary"], {
        allowFailure: true,
        captureOutput: true,
    });
    return result.status === 0 && result.stdout.length > 0 ? result.stdout : undefined;
}

function detectCanaryPackageChanges(): void {
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput === undefined || githubOutput.length === 0) {
        throw new Error("GITHUB_OUTPUT must identify the workflow output file.");
    }

    const fallbackBase = resolveFallbackBase(process.env.PUSHED_FROM);
    for (const canaryPackage of CANARY_PACKAGES) {
        const publishedVersion = readPublishedCanary(canaryPackage.npmName);
        const decision = resolveCanaryPackageChange({
            fallbackBase,
            packagePath: canaryPackage.path,
            publishedVersion,
            hasChanges,
            resolveCommit,
        });

        if (decision.publishedCommit === undefined) {
            console.log(
                `Could not resolve ${canaryPackage.npmName}'s published canary commit; comparing from push fallback ${fallbackBase}.`,
            );
        } else {
            console.log(
                `${canaryPackage.npmName}@${decision.publishedVersion} was published from ${decision.publishedCommit}.`,
            );
        }

        if (decision.changed) {
            console.log(
                `${canaryPackage.npmName} changed since ${decision.base}; publishing its canary build.`,
            );
        } else {
            console.log(
                `${canaryPackage.npmName} is unchanged since ${decision.base}; skipping its canary build.`,
            );
        }
        appendFileSync(githubOutput, `${canaryPackage.output}=${String(decision.changed)}\n`);
    }
}

try {
    detectCanaryPackageChanges();
} catch (error) {
    console.error(
        error instanceof Error
            ? error.message
            : "Could not determine which side-package canaries to publish.",
    );
    process.exitCode = 1;
}
