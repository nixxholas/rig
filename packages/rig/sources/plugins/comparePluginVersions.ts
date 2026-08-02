/**
 * Compares two manifest versions that already passed `pluginVersionSchema`.
 *
 * Build metadata has no precedence. Numeric prerelease identifiers compare numerically and sort
 * below non-numeric identifiers, following Semantic Versioning 2.0.0.
 */
export function comparePluginVersions(left: string, right: string): -1 | 0 | 1 {
    const leftVersion = splitVersion(left);
    const rightVersion = splitVersion(right);
    for (let index = 0; index < leftVersion.core.length; index += 1) {
        const comparison = compareBigInts(
            leftVersion.core[index] ?? 0n,
            rightVersion.core[index] ?? 0n,
        );
        if (comparison !== 0) return comparison;
    }
    if (leftVersion.prerelease === undefined) {
        return rightVersion.prerelease === undefined ? 0 : 1;
    }
    if (rightVersion.prerelease === undefined) return -1;
    const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftIdentifier = leftVersion.prerelease[index];
        const rightIdentifier = rightVersion.prerelease[index];
        if (leftIdentifier === undefined) return -1;
        if (rightIdentifier === undefined) return 1;
        const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
        if (comparison !== 0) return comparison;
    }
    return 0;
}

function splitVersion(version: string): {
    core: readonly bigint[];
    prerelease: readonly string[] | undefined;
} {
    const withoutBuild = version.split("+", 1)[0] ?? version;
    const separator = withoutBuild.indexOf("-");
    const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1).split(".");
    return {
        core: core.split(".").map((part) => BigInt(part)),
        prerelease,
    };
}

function comparePrereleaseIdentifiers(left: string, right: string): -1 | 0 | 1 {
    if (left === right) return 0;
    const leftNumeric = /^[0-9]+$/u.test(left);
    const rightNumeric = /^[0-9]+$/u.test(right);
    if (leftNumeric && rightNumeric) return compareBigInts(BigInt(left), BigInt(right));
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
}

function compareBigInts(left: bigint, right: bigint): -1 | 0 | 1 {
    return left === right ? 0 : left < right ? -1 : 1;
}
