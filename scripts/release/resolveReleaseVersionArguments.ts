export interface ReleaseVersionArguments {
    beta: boolean;
    arguments: readonly string[];
}

const BETA_VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/u;

export function resolveReleaseVersionArguments(
    currentVersion: string,
    requested: string,
): ReleaseVersionArguments {
    if (requested !== "beta") {
        return {
            arguments: [requested, "--no-git-tag-version"],
            beta: BETA_VERSION.test(requested),
        };
    }

    if (currentVersion.includes("-") && !BETA_VERSION.test(currentVersion)) {
        throw new Error(
            `A beta release cannot follow the ${currentVersion} prerelease. Release or replace that channel first.`,
        );
    }

    return {
        arguments: [
            BETA_VERSION.test(currentVersion) ? "prerelease" : "prepatch",
            "--preid",
            "beta",
            "--no-git-tag-version",
        ],
        beta: true,
    };
}
