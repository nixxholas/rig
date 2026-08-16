import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { MAX_COMPUTE_IMAGE_BYTES } from "../../sources/compute/impl/readImage.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-compute-files");
const ONE_PIXEL_PNG = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);

/** A machine holding a small project, and the tools of one agent working on it. */
async function project() {
    const compute = new FakeCompute();
    compute.write("/workspace/readme.md", "# Project\n\nIt does a thing.\n");
    compute.write("/workspace/sources/main.ts", "export function main() {\n    return 1;\n}\n");
    compute.write("/workspace/sources/util.ts", "export const NAME = 'util';\n");
    compute.write("/workspace/sources/data.json", '{"name":"util"}\n');
    return { compute, ...(await computeToolset(ctx, compute)) };
}

describe("compute file tools", () => {
    it("reads a file, numbered, and remembers having read it", async () => {
        const { compute, tool } = await project();

        const read = await tool("read_file").execute(ctx, { path: "sources/util.ts" });

        expect(read.path).toBe("/workspace/sources/util.ts");
        expect(read.content).toBe("1\texport const NAME = 'util';\n2\t");
        expect(read.total_lines).toBe(2);
        expect(read.truncated).toBe(false);

        // Having read it is what lets the next tool change it.
        const edited = await tool("edit_file").execute(ctx, {
            path: "sources/util.ts",
            old_text: "'util'",
            new_text: "'utility'",
        });

        expect(edited).toEqual({ path: "/workspace/sources/util.ts", replacements: 1 });
        expect(compute.files.get("/workspace/sources/util.ts")?.content).toContain("'utility'");
    });

    it("refuses to edit a file this agent never read", async () => {
        const { tool } = await project();

        await expect(
            tool("edit_file").execute(ctx, {
                path: "sources/main.ts",
                old_text: "return 1;",
                new_text: "return 2;",
            }),
        ).rejects.toThrow(/has not been read yet/);
    });

    it("refuses to edit a file that changed after it was read", async () => {
        const { compute, tool } = await project();
        await tool("read_file").execute(ctx, { path: "sources/main.ts" });

        // Somebody else edits the file in the meantime.
        compute.write("/workspace/sources/main.ts", "export function main() {\n    return 7;\n}\n");

        await expect(
            tool("edit_file").execute(ctx, {
                path: "sources/main.ts",
                old_text: "return 7;",
                new_text: "return 8;",
            }),
        ).rejects.toThrow(/changed since it was last read/);
    });

    it("refuses an edit whose text is not unique unless every occurrence is meant", async () => {
        const { compute, tool } = await project();
        compute.write("/workspace/sources/twice.ts", "const a = 1;\nconst a = 1;\n");
        await tool("read_file").execute(ctx, { path: "sources/twice.ts" });

        await expect(
            tool("edit_file").execute(ctx, {
                path: "sources/twice.ts",
                old_text: "const a = 1;",
                new_text: "const b = 2;",
            }),
        ).rejects.toThrow(/appears 2 times/);

        expect(
            await tool("edit_file").execute(ctx, {
                path: "sources/twice.ts",
                old_text: "const a = 1;",
                new_text: "const b = 2;",
                replace_all: true,
            }),
        ).toEqual({ path: "/workspace/sources/twice.ts", replacements: 2 });
    });

    it("creates a file, and lets it be edited straight away", async () => {
        const { compute, tool } = await project();

        const written = await tool("write_file").execute(ctx, {
            path: "sources/new.ts",
            content: "export const answer = 41;\n",
        });

        expect(written).toEqual({
            path: "/workspace/sources/new.ts",
            created: true,
            characters: 26,
        });
        // The write is what the agent knows the file to hold, so no read is needed first.
        await tool("edit_file").execute(ctx, {
            path: "sources/new.ts",
            old_text: "41",
            new_text: "42",
        });
        expect(compute.files.get("/workspace/sources/new.ts")?.content).toBe(
            "export const answer = 42;\n",
        );
    });

    it("refuses to overwrite a file this agent never read", async () => {
        const { tool } = await project();

        await expect(
            tool("write_file").execute(ctx, { path: "readme.md", content: "gone" }),
        ).rejects.toThrow(/has not been read yet/);
    });

    it("deletes a file only after reading it", async () => {
        const { compute, tool } = await project();

        await expect(tool("delete_file").execute(ctx, { path: "readme.md" })).rejects.toThrow(
            /has not been read yet/,
        );
        await tool("read_file").execute(ctx, { path: "readme.md" });
        await expect(tool("delete_file").execute(ctx, { path: "readme.md" })).resolves.toEqual({
            path: "/workspace/readme.md",
            deleted: true,
        });
        expect(compute.files.has("/workspace/readme.md")).toBe(false);
    });

    it("refuses to delete a directory", async () => {
        const { compute, tool } = await project();
        compute.directories.add("/workspace/folder");

        await expect(tool("delete_file").execute(ctx, { path: "folder" })).rejects.toThrow(
            /only removes files/,
        );
    });

    it("moves a read file and creates missing destination directories", async () => {
        const { compute, tool } = await project();

        await tool("read_file").execute(ctx, { path: "sources/util.ts" });
        await expect(
            tool("move_file").execute(ctx, {
                source: "sources/util.ts",
                destination: "archive/util.ts",
            }),
        ).resolves.toEqual({
            source: "/workspace/sources/util.ts",
            destination: "/workspace/archive/util.ts",
        });
        expect(compute.files.has("/workspace/sources/util.ts")).toBe(false);
        expect(compute.files.get("/workspace/archive/util.ts")?.content).toContain("NAME");
    });

    it("refuses an existing destination, the same path, and a directory source", async () => {
        const { compute, tool } = await project();
        compute.write("/workspace/archive/util.ts", "existing\n");
        await tool("read_file").execute(ctx, { path: "sources/util.ts" });

        await expect(
            tool("move_file").execute(ctx, {
                source: "sources/util.ts",
                destination: "archive/util.ts",
            }),
        ).rejects.toThrow(/destination already exists/);
        await expect(
            tool("move_file").execute(ctx, {
                source: "sources/util.ts",
                destination: "sources/util.ts",
            }),
        ).rejects.toThrow(/same path/);

        compute.directories.add("/workspace/folder");
        await expect(
            tool("move_file").execute(ctx, {
                source: "folder",
                destination: "archive/folder",
            }),
        ).rejects.toThrow(/only moves files/);
    });

    it("removes directories it created when a move fails", async () => {
        const { compute, tool } = await project();
        await tool("read_file").execute(ctx, { path: "sources/util.ts" });
        compute.moveFailure = new Error("move failed");

        await expect(
            tool("move_file").execute(ctx, {
                source: "sources/util.ts",
                destination: "new/archive/util.ts",
            }),
        ).rejects.toThrow("move failed");
        expect(compute.directories.has("/workspace/new")).toBe(false);
        expect(compute.directories.has("/workspace/new/archive")).toBe(false);
    });

    it("reviews both destructive paths when either crosses a boundary", async () => {
        const { tool } = await project();

        for (const name of ["delete_file", "move_file"]) {
            const destructive = tool(name);
            const input =
                name === "delete_file"
                    ? { path: "/etc/target" }
                    : { source: "sources/util.ts", destination: "/etc/target" };
            expect(await destructive.shouldReviewInAutoMode(input, ctx)).toBe(true);
            expect(await destructive.shouldRunInFullAccessInAutoMode?.(input, ctx)).toBe(true);
        }
    });

    it("describes move destination boundaries in the approval action", async () => {
        const { tool } = await project();
        const move = tool("move_file");

        expect(
            move.describeAutoPermissionAction?.(
                { source: "sources/util.ts", destination: "/etc/output.ts" },
                ctx,
            ),
        ).toContain(
            'creating destination "/etc/output.ts". Access: unrestricted filesystem access outside the workspace sandbox',
        );
        expect(
            move.describeAutoPermissionAction?.(
                { source: "sources/util.ts", destination: "rig.toml" },
                ctx,
            ),
        ).toContain(
            'creating destination "/workspace/rig.toml". Access: protected project config requiring Full access',
        );
    });

    it("passes on the machine's refusal to write", async () => {
        const { compute, tool } = await project();
        compute.readOnly = true;

        await expect(
            tool("write_file").execute(ctx, { path: "sources/new.ts", content: "nope" }),
        ).rejects.toThrow(/read-only/);
        expect(compute.files.has("/workspace/sources/new.ts")).toBe(false);
    });

    it("lists one directory, marking the directories in it", async () => {
        const { tool } = await project();

        const listed = await tool("list_directory").execute(ctx, {});

        expect(listed.entries).toEqual(["readme.md", "sources/"]);
        expect(listed.truncated).toBe(false);
    });

    it("hides dot-files by default and can include them explicitly", async () => {
        const { compute, tool } = await project();
        compute.write("/workspace/.env", "SECRET=1\n");

        await expect(tool("list_directory").execute(ctx, {})).resolves.toMatchObject({
            entries: ["readme.md", "sources/"],
        });
        await expect(
            tool("list_directory").execute(ctx, { show_hidden: true }),
        ).resolves.toMatchObject({
            entries: [".env", "readme.md", "sources/"],
        });
    });

    it("finds files by pattern, most recently changed first", async () => {
        const { compute, tool } = await project();
        compute.write("/workspace/sources/newest.ts", "export const newest = true;\n");

        const found = await tool("find_files").execute(ctx, { pattern: "**/*.ts" });

        expect(found.files).toEqual([
            "/workspace/sources/newest.ts",
            "/workspace/sources/util.ts",
            "/workspace/sources/main.ts",
        ]);
        expect(found.total_matches).toBe(3);
        expect(found.truncated).toBe(false);
    });

    it("searches file contents, and says where each match is", async () => {
        const { tool } = await project();

        const searched = await tool("search_files").execute(ctx, {
            pattern: "util",
            file_pattern: "**/*.ts",
        });

        expect(searched.matches).toEqual([
            "/workspace/sources/util.ts:1: export const NAME = 'util';",
        ]);
        expect(searched.matched_files).toBe(1);
        expect(searched.truncated).toBe(false);
    });

    it("skips Git-ignored files and supports Grep output modes, context, and offset", async () => {
        const { compute, tool } = await project();
        compute.write(
            "/workspace/.gitignore",
            "ignored/\nignored.txt\nsources/ancestor-ignored.ts\n",
        );
        compute.write("/workspace/.git/HEAD", "ref: refs/heads/main\n");
        compute.write("/workspace/ignored.txt", "util should not be found\n");
        compute.write("/workspace/ignored/inside.ts", "util should not be found\n");
        compute.write("/workspace/sources/ancestor-ignored.ts", "util should not be found\n");
        compute.write(
            "/workspace/sources/context.ts",
            "before\nmatch\nafter\nfar\nbetween\nsecond match\n",
        );

        await expect(
            tool("search_files").execute(ctx, {
                pattern: "util",
                file_pattern: "**/*.ts",
                output_mode: "files_with_matches",
                type: "ts",
            }),
        ).resolves.toMatchObject({
            matches: ["/workspace/sources/util.ts"],
            matched_files: 1,
        });
        await expect(
            tool("search_files").execute(ctx, {
                path: "sources",
                pattern: "util",
                output_mode: "files_with_matches",
                type: "ts",
            }),
        ).resolves.toMatchObject({
            matches: ["/workspace/sources/util.ts"],
            matched_files: 1,
        });
        await expect(
            tool("search_files").execute(ctx, {
                pattern: "match",
                file_pattern: "**/context.ts",
                "-B": 1,
                "-A": 1,
                offset: 1,
                limit: 1,
            }),
        ).resolves.toMatchObject({
            matches: ["/workspace/sources/context.ts:2: match"],
            truncated: true,
        });
        await expect(
            tool("search_files").execute(ctx, {
                pattern: "match",
                file_pattern: "**/context.ts",
                "-C": 1,
                context: 0,
                "-n": false,
            }),
        ).resolves.toMatchObject({
            matches: [
                "/workspace/sources/context.ts- before",
                "/workspace/sources/context.ts: match",
                "/workspace/sources/context.ts- after",
                "--",
                "/workspace/sources/context.ts- between",
                "/workspace/sources/context.ts: second match",
            ],
        });
        await expect(
            tool("search_files").execute(ctx, {
                pattern: "match",
                output_mode: "count",
                file_pattern: "**/context.ts",
            }),
        ).resolves.toMatchObject({
            matches: ["/workspace/sources/context.ts:2"],
            match_count: 2,
        });
        await expect(
            tool("search_files").execute(ctx, { pattern: "match", type: "" }),
        ).rejects.toThrow(/must not be empty/);
    });

    it("returns image blocks for read_file and view_image", async () => {
        const { compute, tool } = await project();
        compute.writeBuffer("/workspace/logo.png", ONE_PIXEL_PNG);

        const read = await tool("read_file").execute(ctx, { path: "logo.png" });
        expect(read.image).toMatchObject({
            mime_type: "image/png",
            bytes: ONE_PIXEL_PNG.byteLength,
            data: Buffer.from(ONE_PIXEL_PNG).toString("base64"),
        });
        expect(tool("read_file").toLLM(read)).toEqual([
            {
                type: "text",
                text: "Image: /workspace/logo.png. Line offset and limit are ignored for image files.",
            },
            {
                type: "image",
                data: Buffer.from(ONE_PIXEL_PNG).toString("base64"),
                mimeType: "image/png",
            },
        ]);

        const viewed = await tool("view_image").execute(ctx, { path: "logo.png" });
        expect(viewed.image).toMatchObject({
            mime_type: "image/png",
            bytes: ONE_PIXEL_PNG.byteLength,
            data: Buffer.from(ONE_PIXEL_PNG).toString("base64"),
        });
        expect(tool("view_image").toLLM(viewed)).toEqual([
            {
                type: "text",
                text: "Image: /workspace/logo.png",
            },
            {
                type: "image",
                data: Buffer.from(ONE_PIXEL_PNG).toString("base64"),
                mimeType: "image/png",
            },
        ]);
        expect(compute.files.has("/workspace/logo.png")).toBe(true);
    });

    it("rejects oversized and unsupported images", async () => {
        const { compute, tool } = await project();
        compute.writeBuffer("/workspace/large.png", new Uint8Array(MAX_COMPUTE_IMAGE_BYTES + 1));
        compute.write("/workspace/not-an-image.txt", "not an image");

        await expect(tool("view_image").execute(ctx, { path: "large.png" })).rejects.toThrow(
            /too large/,
        );
        await expect(tool("view_image").execute(ctx, { path: "not-an-image.txt" })).rejects.toThrow(
            /supported image/,
        );
    });

    it("says how much of a long file it left out", async () => {
        const { compute, tool } = await project();
        const line = "x".repeat(80);
        compute.write(
            "/workspace/sources/long.ts",
            Array.from({ length: 1_000 }, () => line).join("\n"),
        );

        const read = await tool("read_file").execute(ctx, { path: "sources/long.ts" });

        expect(read.truncated).toBe(true);
        expect(read.content).toContain("further characters are not shown");
        expect(read.content.length).toBeLessThan(61_000);
    });
});
