import type { PackageManifest } from "./PackageManifest.js";

const BUNDLED_HAPPY_PACKAGES = ["@slopus/happy-agent", "@slopus/happy-agent-modules"] as const;

/**
 * Ensures unpublished Happy workspaces are available to Rig's build without leaking into the
 * published manifest as dependencies npm cannot resolve.
 */
export function assertBundledHappyRuntimeDependencies(manifest: PackageManifest): void {
    const published = BUNDLED_HAPPY_PACKAGES.filter(
        (dependency) => manifest.dependencies?.[dependency] !== undefined,
    );
    const missingBuildInputs = BUNDLED_HAPPY_PACKAGES.filter(
        (dependency) => manifest.devDependencies?.[dependency] === undefined,
    );
    if (published.length > 0) {
        throw new Error(
            `Rig must bundle unpublished Happy workspaces instead of publishing dependencies on: ${published.join(", ")}.`,
        );
    }
    if (missingBuildInputs.length > 0) {
        throw new Error(
            `Rig is missing bundled Happy build inputs: ${missingBuildInputs.join(", ")}.`,
        );
    }
}
