import type { PackageManifest } from "./PackageManifest.js";

export function assertRegistryLatestMatchesManifest(
    manifest: PackageManifest,
    registryLatestJson: string,
    options: { allowImmediatelyPreviousTaggedPatch?: boolean } = {},
): void {
    const latest = JSON.parse(registryLatestJson) as unknown;
    if (latest !== manifest.version) {
        if (
            options.allowImmediatelyPreviousTaggedPatch === true &&
            typeof latest === "string" &&
            isImmediatelyPreviousPatch(latest, manifest.version)
        ) {
            return;
        }
        throw new Error(
            `${manifest.name} is ${manifest.version} in the worktree but npm latest is ${String(latest)}. Record the published version before releasing again.`,
        );
    }
}

function isImmediatelyPreviousPatch(published: string, current: string): boolean {
    const publishedParts = parseStableVersion(published);
    const currentParts = parseStableVersion(current);
    return (
        publishedParts !== undefined &&
        currentParts !== undefined &&
        publishedParts.major === currentParts.major &&
        publishedParts.minor === currentParts.minor &&
        publishedParts.patch + 1 === currentParts.patch
    );
}

function parseStableVersion(
    version: string,
): { major: number; minor: number; patch: number } | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
    if (match === null) return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}
