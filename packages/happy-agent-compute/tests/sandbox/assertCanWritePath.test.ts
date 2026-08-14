import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import { assertCanWritePath } from "../../sources/sandbox/assertCanWritePath.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function makeWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "agent-compute-write-path-"));
    temporaryDirectories.push(workspace);
    return workspace;
}

describe("assertCanWritePath", () => {
    it("refuses every workspace change in Read only mode", async () => {
        const workspace = await makeWorkspace();
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, "note.txt"),
                computePermissions("read_only"),
            ),
        ).rejects.toThrow("read-only mode");
    });

    it("allows ordinary workspace files in restricted write modes and Full access anywhere", async () => {
        const workspace = await makeWorkspace();
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, "src", "index.ts"),
                computePermissions("workspace_write"),
            ),
        ).resolves.toBeUndefined();
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, "src", "index.ts"),
                computePermissions("auto"),
            ),
        ).resolves.toBeUndefined();
        // Full access removes the boundary, so even a path outside the workspace is permitted.
        await expect(
            assertCanWritePath(workspace, "/etc/hosts", computePermissions("full_access")),
        ).resolves.toBeUndefined();
    });

    it("refuses changes outside the working directory in Workspace write mode", async () => {
        const workspace = await makeWorkspace();
        const outside = await makeWorkspace();
        await expect(
            assertCanWritePath(
                workspace,
                join(outside, "escape.txt"),
                computePermissions("workspace_write"),
            ),
        ).rejects.toThrow("outside the working directory");
    });

    it("protects caller-declared denied paths even with Full access", async () => {
        const workspace = await makeWorkspace();
        await mkdir(join(workspace, "plans"));
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, "plans", "one.md"),
                computePermissions("auto", {
                    deniedWritePaths: [join(workspace, "plans")],
                }),
            ),
        ).rejects.toThrow("denied path");
    });

    it("allows a declared write root outside the workspace", async () => {
        const workspace = await makeWorkspace();
        const outside = await makeWorkspace();

        await expect(
            assertCanWritePath(
                workspace,
                join(outside, "artifact.txt"),
                computePermissions("workspace_write", {
                    allowedWritePaths: [outside],
                }),
            ),
        ).resolves.toBeUndefined();
    });

    it("lets a denial beat a grant for the same write root", async () => {
        const workspace = await makeWorkspace();
        const outside = await makeWorkspace();

        await expect(
            assertCanWritePath(
                workspace,
                join(outside, "artifact.txt"),
                computePermissions("workspace_write", {
                    allowedWritePaths: [outside],
                    deniedWritePaths: [outside],
                }),
            ),
        ).rejects.toThrow("denied path");
    });

    it("protects only the root project files declared by the host policy", async () => {
        const workspace = await makeWorkspace();
        const hostPolicy = {
            protectedProjectFiles: ["agent-policy.toml", "security-policy.md"],
        };
        for (const name of hostPolicy.protectedProjectFiles) {
            await writeFile(join(workspace, name), "");
            await expect(
                assertCanWritePath(
                    workspace,
                    join(workspace, name),
                    computePermissions("workspace_write"),
                    hostPolicy,
                ),
            ).rejects.toThrow(`cannot modify the protected project file ${name}`);
        }
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, "undeclared.toml"),
                computePermissions("workspace_write"),
            ),
        ).resolves.toBeUndefined();
    });

    it("lets a private host-policy path beat an operation grant", async () => {
        const workspace = await makeWorkspace();
        const privateDirectory = await makeWorkspace();

        await expect(
            assertCanWritePath(
                workspace,
                join(privateDirectory, "token"),
                computePermissions("auto", {
                    allowedWritePaths: [privateDirectory],
                }),
                { privateDirectories: [privateDirectory] },
            ),
        ).rejects.toThrow("denied path");
    });

    it("protects Git control files and their symlink aliases", async () => {
        const workspace = await makeWorkspace();
        await mkdir(join(workspace, ".git"));
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, ".git", "config"),
                computePermissions("workspace_write"),
            ),
        ).rejects.toThrow("Git control files");
        await expect(
            assertCanWritePath(
                workspace,
                join(workspace, "nested", ".gitmodules"),
                computePermissions("workspace_write"),
            ),
        ).rejects.toThrow("Git control files");
    });
});
