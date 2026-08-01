export interface CanaryVersionInput {
    buildNumber: string;
    commit: string;
}

/**
 * Canary builds always sit below every real release, so no published version range can ever
 * resolve to one. Installing a canary build has to be a deliberate choice.
 */
export function resolveCanaryVersion({ buildNumber, commit }: CanaryVersionInput): string {
    const build = buildNumber.trim();
    if (!/^\d+$/.test(build)) {
        throw new Error(`${buildNumber} is not a canary build number.`);
    }
    const shortCommit = commit.trim().toLowerCase().slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(shortCommit)) {
        throw new Error(`${commit} is not a commit the canary version can reference.`);
    }

    return `0.0.0-canary.${Number(build)}.${shortCommit}`;
}
