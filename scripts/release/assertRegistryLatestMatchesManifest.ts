import type { PackageManifest } from "./PackageManifest.js";

export function assertRegistryLatestMatchesManifest(
    manifest: PackageManifest,
    registryLatestJson: string,
): void {
    const latest = JSON.parse(registryLatestJson) as unknown;
    if (latest !== manifest.version) {
        throw new Error(
            `${manifest.name} is ${manifest.version} in the worktree but npm latest is ${String(latest)}. Record the published version before releasing again.`,
        );
    }
}
