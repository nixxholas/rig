import { mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
let root: ProjectFileRoot;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "happy-agent-files-"));
    files = new ProjectFilesModule({} as ProjectsModule, {} as WorkspacesModule, {} as GitModule);
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
    });

    it("updates a file when its expected hash is current", async () => {
        const created = await files.write(root, write("before", null));
        const updated = await files.write(root, write("after", created.hash));

        expect(updated.hash).toBe(hash("after"));
        await expect(readFile(join(directory, "note.txt"), "utf8")).resolves.toBe("after");
    });

    it("reports the authoritative hash when a create races an existing file", async () => {
        const created = await files.write(root, write("before", null));

        await expect(files.write(root, write("after", null))).rejects.toMatchObject({
            code: "conflict",
            currentHash: created.hash,
            status: 409,
        } satisfies Partial<ProjectFileError>);
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
