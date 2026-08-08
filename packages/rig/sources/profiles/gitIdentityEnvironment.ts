import type { RigProfile } from "../protocol/index.js";

export function gitIdentityEnvironment(
    profile: Pick<RigProfile, "email" | "name">,
): Readonly<Record<string, string>> {
    return {
        GIT_AUTHOR_EMAIL: profile.email,
        GIT_AUTHOR_NAME: profile.name,
        GIT_COMMITTER_EMAIL: profile.email,
        GIT_COMMITTER_NAME: profile.name,
    };
}
