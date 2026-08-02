import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestFixtureDirectory } from "../../testing/createTestFixtureDirectory.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Project files over HTTP", () => {
    it("lists what Git tracks and what it would add, and leaves out what it ignores", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await mkdir(join(repository, "sources"), { recursive: true });
        await writeFile(join(repository, "sources", "b.txt"), "b\n");
        await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
        await writeFile(join(repository, "ignored.txt"), "hidden\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        const response = await fixture.get(`/projects/${projectId}/file-paths`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            paths: [".gitignore", "seed.txt", "sources/b.txt"],
            truncated: false,
        });
    });

    it("answers with no files when the folder is not a repository", async () => {
        const fixture = await startServer();
        // This one folder lives in the operating system's temporary directory rather than in the
        // fixture root: the fixture root sits inside this repository's own checkout, and Git would
        // find that repository by walking up from any folder placed there.
        const folder = await mkdtemp(join(tmpdir(), "rig-plain-folder-"));
        cleanups.push(async () => await rm(folder, { force: true, recursive: true }));
        await writeFile(join(folder, "a.txt"), "a\n");
        const projectId = fixture.store.create({ cwd: folder }).snapshot().projectId;

        const response = await fixture.get(`/projects/${projectId}/file-paths`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ paths: [], truncated: false });
    });

    it("reports a checkout whose repository is unreadable as a failure, not as no files", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const worktree = join(fixture.root, "worktree");
        await git(repository, ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"]);
        const projectId = fixture.store.create({ cwd: worktree }).snapshot().projectId;
        expect((await fixture.get(`/projects/${projectId}/file-paths`)).body.paths).toEqual([
            "seed.txt",
        ]);

        // A worktree keeps its control directory in the repository it was forked from. Losing that
        // leaves a checkout Git finds and refuses to read, which is a failure rather than a folder
        // that happens to hold no files.
        await rm(join(repository, ".git"), { force: true, recursive: true });
        const response = await fixture.get(`/projects/${projectId}/file-paths`);

        expect(response.status).toBe(400);
        expect(typeof response.body.error).toBe("string");
    });

    it("reads a file as it was at a revision", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const base = await gitOutput(repository, ["rev-parse", "HEAD"]);
        await writeFile(join(repository, "seed.txt"), "changed\n");

        const response = await fixture.get(
            `/projects/${fixture.store.create({ cwd: repository }).snapshot().projectId}` +
                `/file-revision?path=seed.txt&revision=${base}`,
        );

        expect(response.status).toBe(200);
        expect(Buffer.from(response.body.content, "base64").toString("utf8")).toBe("seed\n");
        expect(response.body.hash).toBe(createHash("sha256").update("seed\n").digest("hex"));
    });

    it("tells a file the revision never had apart from a read that failed", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        await writeFile(join(repository, "added.txt"), "new\n");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        const added = await fixture.get(
            `/projects/${projectId}/file-revision?path=added.txt&revision=HEAD`,
        );
        const broken = await fixture.get(
            `/projects/${projectId}/file-revision?path=seed.txt&revision=nosuchrevision`,
        );

        expect(added.status).toBe(200);
        expect(added.body).toEqual({ content: null, hash: null });
        expect(broken.status).toBe(400);
        expect(typeof broken.body.error).toBe("string");
    });

    it("refuses a path outside the folder and a revision Git would read as an option", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        const outside = await fixture.get(
            `/projects/${projectId}/file-revision?path=${encodeURIComponent("../escape.txt")}&revision=HEAD`,
        );
        const option = await fixture.get(
            `/projects/${projectId}/file-revision?path=seed.txt&revision=${encodeURIComponent("--output=/tmp/x")}`,
        );

        expect(outside.status).toBe(403);
        expect(option.status).toBe(400);
    });

    it("serves both routes for a workspace as it does for a project", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const workspace = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "check",
        });
        // The worktree is materialized in the background, so its files exist a moment later.
        await waitUntil(
            () => fixture.store.getWorkspace(projectId, workspace!.id)?.status === "ready",
        );
        await writeFile(join(workspace!.path, "seed.txt"), "changed\n");
        const scope = `/projects/${projectId}/workspaces/${workspace!.id}`;

        const paths = await fixture.get(`${scope}/file-paths`);
        const revision = await fixture.get(`${scope}/file-revision?path=seed.txt&revision=HEAD`);

        expect(paths.status).toBe(200);
        expect(paths.body.paths).toContain("seed.txt");
        expect(revision.status).toBe(200);
        expect(Buffer.from(revision.body.content, "base64").toString("utf8")).toBe("seed\n");
    });

    it("reports an unknown project and an unknown workspace as missing", async () => {
        const fixture = await startServer();
        const repository = await createRepository(fixture.root);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        expect((await fixture.get("/projects/nope/file-paths")).status).toBe(404);
        expect(
            (await fixture.get(`/projects/${projectId}/workspaces/nope/file-revision`)).status,
        ).toBe(404);
    });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for the workspace.");
}

async function startServer(): Promise<{
    get: (path: string) => Promise<{ body: any; status: number }>;
    root: string;
    store: InMemorySessionStore;
}> {
    const root = await createTestFixtureDirectory();
    const socketDirectory = await createTestSocketDirectory();
    const socketPath = join(socketDirectory, "server.sock");
    const store = new InMemorySessionStore({ workspacesDirectory: join(root, "workspaces") });
    const server: Server = createProtocolHttpServer({ store, token: "t" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([
            rm(root, { force: true, recursive: true }),
            rm(socketDirectory, { force: true, recursive: true }),
        ]);
    });

    const get = async (path: string) =>
        await new Promise<{ body: any; status: number }>((resolve, reject) => {
            const call = httpRequest(
                { headers: { authorization: "Bearer t" }, path, socketPath },
                (response) => {
                    let raw = "";
                    response.on("data", (chunk) => (raw += String(chunk)));
                    response.on("end", () =>
                        resolve({
                            body: raw.length === 0 ? undefined : JSON.parse(raw),
                            status: response.statusCode ?? 0,
                        }),
                    );
                },
            );
            call.on("error", reject);
            call.end();
        });

    return { get, root, store };
}

async function createRepository(root: string): Promise<string> {
    const repository = join(root, `repo-${String(Math.trunc(performance.now() * 1000))}`);
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Test"]);
    await writeFile(join(repository, "seed.txt"), "seed\n");
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "--message", "seed"]);
    await git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000 });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 20_000,
    });
    return result.stdout.trim();
}
