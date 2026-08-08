import { describe, expect, it } from "vitest";

import { prepareRemoteWorkGitSecret } from "../prepareRemoteWorkGitSecret.js";

const secrets = {
    resolveSpecialSecret: () => ({ GH_TOKEN: "native-github-token" }),
};

describe("prepareRemoteWorkGitSecret", () => {
    it("shares GitHub material only for an explicitly credentialed GitHub operation", () => {
        for (const [path, body] of [
            [
                "/projects/clone",
                {
                    secret: { kind: "github" },
                    source: { kind: "github", repository: "slopus/rig" },
                },
            ],
            ["/projects/project-1/workspaces", { secret: { kind: "github" } }],
            ["/sessions/session-1/messages", { gitSecret: { kind: "github" }, text: "Push it" }],
        ] as const) {
            expect(decode(prepareRemoteWorkGitSecret(path, encode(body), secrets))).toMatchObject({
                temporaryGitSecret: { kind: "github", token: "native-github-token" },
            });
        }
    });

    it("does not share a GitHub token with generic Git or unrelated sessions", () => {
        for (const [path, body] of [
            [
                "/projects/clone",
                {
                    source: { kind: "git", url: "https://git.example.test/team/repo.git" },
                },
            ],
            ["/projects/clone", { source: { kind: "github", repository: "slopus/rig" } }],
            ["/sessions/session-1/messages", { text: "No repository credential needed" }],
        ] as const) {
            expect(prepareRemoteWorkGitSecret(path, encode(body), secrets)).toBeUndefined();
        }
    });

    it("forwards an explicit selector without material when the native credential is unavailable", () => {
        expect(
            prepareRemoteWorkGitSecret("/sessions", encode({ gitSecret: { kind: "github" } }), {
                resolveSpecialSecret() {
                    throw new Error("missing");
                },
            }),
        ).toBeUndefined();
    });

    it("replaces client-supplied temporary material with the daemon-owned credential", () => {
        expect(
            decode(
                prepareRemoteWorkGitSecret(
                    "/sessions/session-1/messages",
                    encode({
                        gitSecret: { kind: "github" },
                        temporaryGitSecret: { kind: "github", token: "client-token" },
                        text: "Push it",
                    }),
                    secrets,
                ),
            ),
        ).toMatchObject({
            temporaryGitSecret: { kind: "github", token: "native-github-token" },
        });
    });
});

function encode(value: unknown): Uint8Array {
    return Buffer.from(JSON.stringify(value), "utf8");
}

function decode(value: Uint8Array | undefined): Record<string, unknown> | undefined {
    return value === undefined
        ? undefined
        : (JSON.parse(Buffer.from(value).toString("utf8")) as Record<string, unknown>);
}
