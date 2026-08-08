import { describe, expect, it } from "vitest";

import {
    cloneRemoteRepository,
    type GitCloneExecFile,
    type GitCloneExecFileOptions,
} from "../cloneRemoteRepository.js";

const gitIdentity = { email: "steve@example.test", name: "Steve Korshakov" };

describe("cloneRemoteRepository", () => {
    it("clones arbitrary HTTPS Git repositories without injecting authentication", async () => {
        const invocation = await captureClone({
            destination: "/Home/Projects/example",
            source: { kind: "git", url: "https://git.example.test/team/example.git" },
        });

        expect(invocation).toMatchObject({
            args: [
                "clone",
                "--",
                "https://git.example.test/team/example.git",
                "/Home/Projects/example",
            ],
            file: "git",
            options: {
                env: {
                    GIT_CONFIG_COUNT: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_CONFIG_KEY_0: "credential.helper",
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_VALUE_0: "",
                    GIT_TERMINAL_PROMPT: "0",
                },
                maxBuffer: 1024 * 1024,
                timeout: 60 * 60 * 1_000,
            },
        });
        expect(invocation.options.env).not.toHaveProperty("GIT_CONFIG_KEY_1");
        expect(invocation.options.env).not.toHaveProperty("GIT_CONFIG_VALUE_1");
        expect(invocation.options.env).toMatchObject({
            GIT_AUTHOR_EMAIL: gitIdentity.email,
            GIT_AUTHOR_NAME: gitIdentity.name,
            GIT_COMMITTER_EMAIL: gitIdentity.email,
            GIT_COMMITTER_NAME: gitIdentity.name,
        });
    });

    it("uses the broker capability without putting real credentials in its environment", async () => {
        const capability = "a".repeat(64);
        const gitAuthentication = {
            environment: {
                GIT_CONFIG_COUNT: "2",
                GIT_CONFIG_KEY_0: "credential.helper",
                GIT_CONFIG_KEY_1: `url.http://127.0.0.1:41000/${capability}/github.com/slopus/rig.git.insteadOf`,
                GIT_CONFIG_VALUE_0: "",
                GIT_CONFIG_VALUE_1: "https://github.com/slopus/rig.git",
            },
            loopbackPort: 41_000,
        };
        const invocation = await captureClone({
            destination: "/Home/Projects/rig",
            gitAuthentication,
            source: { kind: "github", repository: "slopus/rig" },
        });

        expect(invocation.args).toEqual([
            "clone",
            "--",
            "https://github.com/slopus/rig.git",
            "/Home/Projects/rig",
        ]);
        expect(invocation.options.env).toMatchObject({
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "credential.helper",
            GIT_CONFIG_KEY_1: `url.http://127.0.0.1:41000/${capability}/github.com/slopus/rig.git.insteadOf`,
            GIT_CONFIG_VALUE_1: "https://github.com/slopus/rig.git",
            GIT_TERMINAL_PROMPT: "0",
        });
    });

    it("redacts the broker capability from Git failures before they can be persisted", async () => {
        const capability = "b".repeat(64);
        const prefix = `http://127.0.0.1:41000/${capability}/`;

        await expect(
            cloneRemoteRepository({
                destination: "/Home/Projects/rig",
                execFile: async () => {
                    throw new Error(`fatal: unable to access '${prefix}github.com/slopus/rig.git'`);
                },
                gitAuthentication: {
                    environment: {
                        GIT_CONFIG_KEY_1: `url.${prefix}github.com/slopus/rig.git.insteadOf`,
                    },
                    loopbackPort: 41_000,
                },
                gitIdentity,
                source: { kind: "github", repository: "slopus/rig" },
            }),
        ).rejects.toThrow("http://127.0.0.1/[Rig Git authentication]/github.com/slopus/rig.git");
    });

    it("does not configure a credential header for an unauthenticated GitHub clone", async () => {
        const invocation = await captureClone({
            destination: "/Home/Projects/rig",
            source: { kind: "github", repository: "slopus/rig" },
        });

        expect(invocation.options.env).toMatchObject({
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "credential.helper",
            GIT_CONFIG_VALUE_0: "",
        });
        expect(invocation.options.env).not.toHaveProperty("GIT_CONFIG_KEY_1");
        expect(invocation.options.env).not.toHaveProperty("GIT_CONFIG_VALUE_1");
    });

    it.each([
        "file:///tmp/repository",
        "/tmp/repository",
        "./repository",
        "../repository",
        "ext::sh -c whoami",
        "custom::repository",
        "https://token@git.example.test/team/example.git",
        "https://token:secret@git.example.test/team/example.git",
        "ssh://git@git.example.test/team/example.git",
    ])("rejects unsafe arbitrary Git source %j", async (url) => {
        await expect(
            cloneRemoteRepository({
                destination: "/Home/Projects/example",
                execFile: unexpectedExecution,
                gitIdentity,
                source: { kind: "git", url },
            }),
        ).rejects.toThrow(/Git remote URL/u);
    });

    it("rejects malformed GitHub coordinates and unsafe destinations before execution", async () => {
        await expect(
            cloneRemoteRepository({
                destination: "/Home/Projects/example",
                execFile: unexpectedExecution,
                gitIdentity,
                source: { kind: "github", repository: "slopus/../rig" },
            }),
        ).rejects.toThrow("owner/repository");
        await expect(
            cloneRemoteRepository({
                destination: "relative/project",
                execFile: unexpectedExecution,
                gitIdentity,
                source: { kind: "github", repository: "slopus/rig" },
            }),
        ).rejects.toThrow("absolute, normalized path");
    });
});

async function captureClone(input: {
    destination: string;
    gitAuthentication?: {
        environment: Readonly<Record<string, string>>;
        loopbackPort: number;
    };
    source: { kind: "github"; repository: string } | { kind: "git"; url: string };
}): Promise<{
    args: readonly string[];
    file: string;
    options: GitCloneExecFileOptions;
}> {
    let invocation:
        | {
              args: readonly string[];
              file: string;
              options: GitCloneExecFileOptions;
          }
        | undefined;
    const execFile: GitCloneExecFile = async (file, args, options) => {
        invocation = {
            args,
            file,
            options: {
                ...options,
                env: { ...options.env },
            },
        };
        return { stderr: "", stdout: "" };
    };

    await cloneRemoteRepository({ ...input, execFile, gitIdentity });

    if (invocation === undefined) throw new Error("Expected Git clone execution.");
    return invocation;
}

const unexpectedExecution: GitCloneExecFile = async () => {
    throw new Error("Git execution must not run for an invalid clone request.");
};
