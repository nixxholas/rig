import { describe, expect, it } from "vitest";

import { createSandboxFilesystemConfig } from "../../sources/sandbox/createSandboxFilesystemConfig.js";

describe("createSandboxFilesystemConfig", () => {
    it("denies the private home directory and re-allows the selected workspace", async () => {
        const config = await createSandboxFilesystemConfig({
            cwd: "/home/tester/projects/app",
            environment: {
                AWS_SHARED_CREDENTIALS_FILE: "/secrets/aws-credentials",
                CLAUDE_CONFIG_DIR: "/secrets/claude",
                CODEX_HOME: "/secrets/codex",
                EMBEDDER_PRIVATE_PATH: "/run/agent/private-token",
                PATH: "/home/tester/.cargo/bin:/home/tester/.ssh/bin:/usr/bin",
                XDG_CONFIG_HOME: "/home/tester/custom-config",
            },
            hostPolicy: {
                privateDirectories: ["/private/agent-state"],
                privatePathVariables: ["EMBEDDER_PRIVATE_PATH"],
                readableDirectories: ["/opt/agent/skills"],
            },
            homeDirectory: "/home/tester",
            mode: "workspace_write",
            sandboxConfigDirectory: "/temporary/sandbox-policy",
            temporaryDirectory: "/temporary",
        });

        expect(config.allowRead).toContain("/home/tester/projects/app");
        expect(config.allowRead).toContain("/opt/agent/skills");
        expect(config.allowRead).not.toContain("/home/tester/.codex/skills");
        expect(config.allowRead).not.toContain("/home/tester/.agents/skills");
        if (process.platform !== "win32") {
            expect(config.allowRead.some((path) => path.endsWith("/home/tester/.cargo/bin"))).toBe(
                true,
            );
            expect(config.allowRead).not.toContain("/home/tester/.ssh/bin");
        }
        expect(config.allowWrite).toContain("/home/tester/projects/app");
        expect(config.allowWrite).toContain("/temporary");
        expect(config.denyRead).toEqual(
            expect.arrayContaining([
                "/home/tester",
                "/home/tester/.ssh",
                "/home/tester/.aws",
                "/home/tester/.claude",
                "/home/tester/.codex",
                "/home/tester/custom-config/gh",
                "/private/agent-state",
                "/secrets/aws-credentials",
                "/secrets/claude",
                "/secrets/codex",
                "/run/agent/private-token",
                "/temporary/sandbox-policy",
            ]),
        );
        expect(config.denyWrite).toEqual([
            "/private/agent-state",
            "/run/agent/private-token",
            "/temporary/sandbox-policy",
        ]);
    });

    it("makes an explicitly granted socket writable without widening the workspace", async () => {
        const config = await createSandboxFilesystemConfig({
            cwd: "/home/tester/projects/app",
            environment: {},
            homeDirectory: "/home/tester",
            mode: "read_only",
            temporaryDirectory: "/temporary",
            unixSocketPaths: ["/runtime/worker.sock"],
        });

        // Connecting to a Unix socket writes to the socket itself, so it alone becomes writable.
        expect(config.allowWrite).toContain("/runtime/worker.sock");
        expect(config.allowWrite).not.toContain("/runtime");
        expect(config.allowWrite).not.toContain("/home/tester/projects/app");
    });

    it("carries operation-specific read and write grants and denials into the sandbox config", async () => {
        const config = await createSandboxFilesystemConfig({
            additionalReadablePaths: ["/shared/reference"],
            additionalWritablePaths: ["/shared/output"],
            cwd: "/workspace",
            deniedReadPaths: ["/workspace/private"],
            deniedWritePaths: ["/shared/output/locked"],
            environment: {},
            homeDirectory: "/home/tester",
            mode: "workspace_write",
            temporaryDirectory: "/temporary",
        });

        expect(config.allowRead).toContain("/shared/reference");
        expect(config.allowWrite).toContain("/shared/output");
        expect(config.denyRead).toContain("/workspace/private");
        expect(config.denyWrite).toContain("/shared/output/locked");
    });

    it("keeps declared private and explicit read denials while Full access removes universal defaults", async () => {
        const config = await createSandboxFilesystemConfig({
            cwd: "/workspace",
            deniedReadPaths: ["/workspace/private"],
            environment: {},
            filesystemFullAccess: true,
            hostPolicy: { privateDirectories: ["/private/agent-state"] },
            homeDirectory: "/home/tester",
            mode: "workspace_write",
            sandboxConfigDirectory: "/temporary/sandbox-config",
            temporaryDirectory: "/temporary",
        });

        expect(config.denyRead).toEqual([
            "/temporary/sandbox-config",
            "/private/agent-state",
            "/workspace/private",
        ]);
        expect(config.denyRead).not.toContain("/home/tester");
    });
});
