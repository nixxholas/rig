import { mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitModule } from "../../sources/git/index.js";
import {
    fileRevisionQuerySchema,
    ProjectFileError,
    ProjectFilesModule,
    type ProjectFileRoot,
} from "../../sources/files/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";

let directory: string;
let files: ProjectFilesModule;
let invalidateGit: ReturnType<typeof vi.fn>;
let markGitChanged: ReturnType<typeof vi.fn>;
let root: ProjectFileRoot;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "happy-agent-files-"));
    invalidateGit = vi.fn();
    markGitChanged = vi.fn();
    files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        {
            invalidate: invalidateGit,
            markChanged: markGitChanged,
        } as unknown as GitModule,
    );
    root = { projectId: "project-1", root: await realpath(directory) };
});

afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
});

describe("ProjectFilesModule writes", () => {
    it("creates a missing file only when the expected hash is null", async () => {
        const created = await files.write(root, write("new file", null));

        expect(created.hash).toBe(hash("new file"));
        await expect(readFile(join(directory, "note.txt"), "utf8")).resolves.toBe("new file");
        expect(invalidateGit).toHaveBeenCalledWith(root.root);
        expect(markGitChanged).toHaveBeenCalledWith({
            path: root.root,
            projectId: root.projectId,
        });
    });

    it("creates missing parent directories beneath the confined root", async () => {
        const created = await files.write(root, {
            content: Buffer.from("nested file").toString("base64"),
            expectedHash: null,
            path: "generated/deep/note.txt",
        });

        expect(created.hash).toBe(hash("nested file"));
        await expect(readFile(join(directory, "generated/deep/note.txt"), "utf8")).resolves.toBe(
            "nested file",
        );
    });

    it("updates a file when its expected hash is current", async () => {
        const created = await files.write(root, write("before", null));
        const updated = await files.write(root, write("after", created.hash));

        expect(updated.hash).toBe(hash("after"));
        await expect(readFile(join(directory, "note.txt"), "utf8")).resolves.toBe("after");
    });

    it("reports the authoritative hash when a create races an existing file", async () => {
        const created = await files.write(root, write("before", null));
        invalidateGit.mockClear();
        markGitChanged.mockClear();

        await expect(files.write(root, write("after", null))).rejects.toMatchObject({
            code: "conflict",
            currentHash: created.hash,
            status: 409,
        } satisfies Partial<ProjectFileError>);
        expect(invalidateGit).not.toHaveBeenCalled();
        expect(markGitChanged).not.toHaveBeenCalled();
    });

    it("reports the authoritative hash when a write is stale", async () => {
        const created = await files.write(root, write("before", null));
        const updated = await files.write(root, write("current", created.hash));

        await expect(files.write(root, write("stale", created.hash))).rejects.toMatchObject({
            code: "conflict",
            currentHash: updated.hash,
            status: 409,
        } satisfies Partial<ProjectFileError>);
    });

    it("reports null when the expected file was deleted", async () => {
        const created = await files.write(root, write("before", null));
        await unlink(join(directory, "note.txt"));

        await expect(files.write(root, write("after", created.hash))).rejects.toMatchObject({
            code: "conflict",
            currentHash: null,
            status: 409,
        } satisfies Partial<ProjectFileError>);
    });

    it("serializes concurrent writes so the loser receives the winner's hash", async () => {
        const created = await files.write(root, write("before", null));
        const results = await Promise.allSettled([
            files.write(root, write("left", created.hash)),
            files.write(root, write("right", created.hash)),
        ]);
        const winner = results.find(
            (result): result is PromiseFulfilledResult<{ readonly hash: string }> =>
                result.status === "fulfilled",
        );
        const loser = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
        );

        expect(winner).toBeDefined();
        if (winner === undefined) throw new Error("One compare-and-swap write must succeed.");
        expect(loser?.reason).toMatchObject({
            code: "conflict",
            currentHash: winner.value.hash,
            status: 409,
        } satisfies Partial<ProjectFileError>);
        await expect(readFile(join(directory, "note.txt"), "utf8")).resolves.toBe(
            winner.value.hash === hash("left") ? "left" : "right",
        );
    });
});

describe("ProjectFilesModule revision queries", () => {
    it("accepts Git commit-ish selectors without accepting options or whitespace", () => {
        expect(Value.Check(fileRevisionQuerySchema, { path: "note.txt", revision: "HEAD~1" })).toBe(
            true,
        );
        expect(
            Value.Check(fileRevisionQuerySchema, {
                path: "note.txt",
                revision: "main^{commit}",
            }),
        ).toBe(true);
        expect(Value.Check(fileRevisionQuerySchema, { path: "note.txt", revision: "--help" })).toBe(
            false,
        );
        expect(Value.Check(fileRevisionQuerySchema, { path: "note.txt", revision: "HEAD 1" })).toBe(
            false,
        );
    });
});

function write(content: string, expectedHash: string | null) {
    return {
        content: Buffer.from(content, "utf8").toString("base64"),
        expectedHash,
        path: "note.txt",
    };
}

function hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}
