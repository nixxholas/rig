import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-features-compute-files");

/** A machine holding a small project, and the tools of one agent working on it. */
function project() {
    const compute = new FakeCompute();
    compute.write("/workspace/readme.md", "# Project\n\nIt does a thing.\n");
    compute.write("/workspace/sources/main.ts", "export function main() {\n    return 1;\n}\n");
    compute.write("/workspace/sources/util.ts", "export const NAME = 'util';\n");
    compute.write("/workspace/sources/data.json", '{"name":"util"}\n');
    return { compute, ...computeToolset(ctx, compute) };
}

describe("compute file tools", () => {
    it("reads a file, numbered, and remembers having read it", async () => {
        const { compute, tool } = project();

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
        const { tool } = project();

        await expect(
            tool("edit_file").execute(ctx, {
                path: "sources/main.ts",
                old_text: "return 1;",
                new_text: "return 2;",
            }),
        ).rejects.toThrow(/has not been read yet/);
    });

    it("refuses to edit a file that changed after it was read", async () => {
        const { compute, tool } = project();
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
        const { compute, tool } = project();
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
        const { compute, tool } = project();

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
        const { tool } = project();

        await expect(
            tool("write_file").execute(ctx, { path: "readme.md", content: "gone" }),
        ).rejects.toThrow(/has not been read yet/);
    });

    it("passes on the machine's refusal to write", async () => {
        const { compute, tool } = project();
        compute.readOnly = true;

        await expect(
            tool("write_file").execute(ctx, { path: "sources/new.ts", content: "nope" }),
        ).rejects.toThrow(/read-only/);
        expect(compute.files.has("/workspace/sources/new.ts")).toBe(false);
    });

    it("lists one directory, marking the directories in it", async () => {
        const { tool } = project();

        const listed = await tool("list_directory").execute(ctx, {});

        expect(listed.entries).toEqual(["readme.md", "sources/"]);
        expect(listed.truncated).toBe(false);
    });

    it("finds files by pattern, most recently changed first", async () => {
        const { compute, tool } = project();
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
        const { tool } = project();

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

    it("says how much of a long file it left out", async () => {
        const { compute, tool } = project();
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
