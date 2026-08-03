import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "../../agent/context/createNodeFileSystemContext.js";
import type { ListFileTreeRequest } from "../../protocol/index.js";
import {
    FileTreeChangedError,
    FileTreeInvalidRequestError,
    FileTreeProtectedPathError,
    FileTreeSymlinkTraversalError,
    listFileTree,
} from "../index.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("listFileTree", () => {
    it("lists ignored scratch and empty directories without exposing Git control files", async () => {
        const root = await fixture();
        await mkdir(join(root, ".context"));
        await mkdir(join(root, ".git"));
        await writeFile(join(root, ".gitconfig"), "private\n");
        await writeFile(join(root, ".gitmodules"), "private\n");
        await mkdir(join(root, "empty"));
        await mkdir(join(root, "sources"));
        await writeFile(join(root, ".gitignore"), ".context/\n");
        await writeFile(join(root, ".context", "notes.md"), "scratch\n");
        await writeFile(join(root, "sources", "index.ts"), "export {};\n");
        await symlink(join(root, "sources"), join(root, "source-link"));

        const page = await listFileTree(fileSystem(root), { path: "" });

        expect(page.path).toBe("");
        expect(page.nextCursor).toBeNull();
        expect(page.entries.map((entry) => [entry.name, entry.type])).toEqual([
            [".context", "directory"],
            [".gitconfig", "file"],
            [".gitignore", "file"],
            [".gitmodules", "file"],
            ["empty", "directory"],
            ["source-link", "symlink"],
            ["sources", "directory"],
        ]);
        await expect(listFileTree(fileSystem(root), { path: ".git" })).rejects.toBeInstanceOf(
            FileTreeProtectedPathError,
        );
        await expect(listFileTree(fileSystem(root), { path: ".GIT" })).rejects.toBeInstanceOf(
            FileTreeProtectedPathError,
        );
        await expect(
            listFileTree(fileSystem(root), { path: ".Git/objects" }),
        ).rejects.toBeInstanceOf(FileTreeProtectedPathError);
    });

    it("paginates a large flat directory with stable bounded pages", async () => {
        const root = await fixture();
        await mkdir(join(root, "many"));
        const names = Array.from({ length: 1_337 }, (_, index) => {
            return `file-${String(index).padStart(4, "0")}.txt`;
        });
        for (let offset = 0; offset < names.length; offset += 100) {
            await Promise.all(
                names
                    .slice(offset, offset + 100)
                    .map(async (name) => await writeFile(join(root, "many", name), name)),
            );
        }

        const collected: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await listFileTree(fileSystem(root), {
                ...(cursor === undefined ? {} : { cursor }),
                limit: 37,
                path: "many",
            });
            expect(page.entries.length).toBeLessThanOrEqual(37);
            collected.push(...page.entries.map((entry) => entry.name));
            cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);

        expect(collected).toEqual(names);
        expect(new Set(collected).size).toBe(names.length);
    });

    it("invalidates a cursor when its directory changes or it is used on another path", async () => {
        const root = await fixture();
        await mkdir(join(root, "first"));
        await mkdir(join(root, "second"));
        await writeFile(join(root, "first", "a.txt"), "a\n");
        await writeFile(join(root, "first", "b.txt"), "b\n");
        const initial = await listFileTree(fileSystem(root), { limit: 1, path: "first" });
        expect(initial.nextCursor).toEqual(expect.any(String));

        await expect(
            listFileTree(fileSystem(root), {
                cursor: initial.nextCursor!,
                limit: 1,
                path: "second",
            }),
        ).rejects.toBeInstanceOf(FileTreeInvalidRequestError);

        const changed = new Date(Date.now() + 10_000);
        await utimes(join(root, "first"), changed, changed);
        await expect(
            listFileTree(fileSystem(root), {
                cursor: initial.nextCursor!,
                limit: 1,
                path: "first",
            }),
        ).rejects.toBeInstanceOf(FileTreeChangedError);
    });

    it("allows a best-effort first page when the directory changes during listing", async () => {
        const root = await fixture();
        await writeFile(join(root, "alpha.txt"), "alpha\n");
        const base = fileSystem(root);
        const changing = {
            ...base,
            async readdirPage(path: string, options: { after?: string; limit: number }) {
                const page = await base.readdirPage(path, options);
                await writeFile(join(root, "created-during-listing.txt"), "new\n");
                return page;
            },
        };

        await expect(listFileTree(changing, { limit: 1, path: "" })).resolves.toMatchObject({
            entries: [expect.objectContaining({ name: "alpha.txt" })],
        });
    });

    it("continues past a page containing only filtered Git directories", async () => {
        const root = await fixture();
        await writeFile(join(root, "zeta.txt"), "zeta\n");
        const base = fileSystem(root);
        const names = [".GIT", ".GIt", ".GiT", ".Git", ".gIT", ".gIt", ".giT", ".git", "zeta.txt"];
        const filtered = {
            ...base,
            async readdirPage(_path: string, options: { after?: string; limit: number }) {
                const start =
                    options.after === undefined
                        ? 0
                        : names.findIndex((name) => name === options.after) + 1;
                const page = names.slice(start, start + options.limit);
                return {
                    entries: page,
                    hasMore: start + page.length < names.length,
                };
            },
        };

        await expect(listFileTree(filtered, { limit: 1, path: "" })).resolves.toMatchObject({
            entries: [expect.objectContaining({ name: "zeta.txt" })],
            nextCursor: null,
        });
    });

    it("shows symlinks but never traverses one", async () => {
        const root = await fixture();
        await mkdir(join(root, "target"));
        await writeFile(join(root, "target", "inside.txt"), "inside\n");
        await symlink(join(root, "target"), join(root, "link"));

        const rootPage = await listFileTree(fileSystem(root), { path: "" });
        expect(rootPage.entries).toContainEqual(
            expect.objectContaining({ name: "link", type: "symlink" }),
        );
        await expect(listFileTree(fileSystem(root), { path: "link" })).rejects.toBeInstanceOf(
            FileTreeSymlinkTraversalError,
        );
    });

    it.each([
        ".",
        "..",
        "../outside",
        "a\nb/../../outside",
        "/absolute",
        "double//slash",
        "back\\slash",
    ])("rejects the malformed relative path %s", async (path) => {
        const root = await fixture();
        await expect(
            listFileTree(fileSystem(root), { path } as ListFileTreeRequest),
        ).rejects.toBeInstanceOf(FileTreeInvalidRequestError);
    });
});

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-file-tree-"));
    directories.push(root);
    return root;
}

function fileSystem(root: string) {
    return createNodeFileSystemContext(root, { permissionMode: () => "workspace_write" });
}
