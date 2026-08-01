const CANARY_VERSION = /^0\.0\.0-canary\.\d+\.([0-9a-f]{7})$/u;

export interface CanaryPackageChangeInput {
    fallbackBase: string;
    packagePath: string;
    publishedVersion: string | undefined;
    hasChanges: (base: string, packagePath: string) => boolean;
    resolveCommit: (reference: string) => string | undefined;
}

export interface CanaryPackageChange {
    base: string;
    changed: boolean;
    publishedCommit: string | undefined;
    publishedVersion: string | undefined;
}

export function parseCanaryCommit(version: string | undefined): string | undefined {
    return version?.trim().match(CANARY_VERSION)?.[1];
}

export function resolveCanaryPackageChange({
    fallbackBase,
    packagePath,
    publishedVersion,
    hasChanges,
    resolveCommit,
}: CanaryPackageChangeInput): CanaryPackageChange {
    const publishedCommit = parseCanaryCommit(publishedVersion);
    const resolvedPublishedCommit =
        publishedCommit === undefined ? undefined : resolveCommit(publishedCommit);
    const base = resolvedPublishedCommit ?? fallbackBase;

    return {
        base,
        changed: hasChanges(base, packagePath),
        publishedCommit: resolvedPublishedCommit,
        publishedVersion:
            resolvedPublishedCommit === undefined ? undefined : publishedVersion?.trim(),
    };
}
