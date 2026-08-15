import { describe, expect, it } from "vitest";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { claudeEditTool } from "../../agent/tools/claude/Edit.js";
import { claudeReadTool } from "../../agent/tools/claude/Read.js";

describe("Claude Code Edit tool", () => {
    it("remains strict about exact text", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/edit.txt": "alpha  \nbeta\n" },
        });
        await harness.runTool(claudeReadTool, { file_path: "/workspace/edit.txt" });

        await expect(
            harness.runTool(claudeEditTool, {
                file_path: "/workspace/edit.txt",
                old_string: "alpha\nbeta",
                new_string: "gamma\nbeta",
            }),
        ).rejects.toThrow(/old_string was not found/);

        const result = await harness.runTool(claudeEditTool, {
            file_path: "/workspace/edit.txt",
            old_string: "alpha  \nbeta",
            new_string: "gamma\nbeta",
        });

        expect(result.replacements).toBe(1);
        expect(
            claudeEditTool.toPresentation?.(result, {
                file_path: "/workspace/edit.txt",
                old_string: "alpha  \nbeta",
                new_string: "gamma\nbeta",
            }),
        ).toEqual({
            files: [
                {
                    hunks: [
                        {
                            lines: [
                                { kind: "delete", text: "alpha  " },
                                { kind: "delete", text: "beta" },
                                { kind: "add", text: "gamma" },
                                { kind: "add", text: "beta" },
                            ],
                            newStart: 1,
                            oldStart: 1,
                        },
                    ],
                    kind: "update",
                    path: "/workspace/edit.txt",
                },
            ],
            type: "file_diff",
        });
        expect(await harness.readFile("/workspace/edit.txt")).toBe("gamma\nbeta\n");
    });

    it("gives actionable guidance when the exact text is ambiguous", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/edit.txt": "same\nsame\n" },
        });
        await harness.runTool(claudeReadTool, { file_path: "/workspace/edit.txt" });

        const edit = harness.runTool(claudeEditTool, {
            file_path: "/workspace/edit.txt",
            old_string: "same",
            new_string: "changed",
        });

        await expect(edit).rejects.toThrow("include more surrounding context to make it unique");
        await expect(edit).rejects.not.toThrow("line_number");
    });

    it("bounds replace-all diffs while preserving exact totals", async () => {
        const content = `${Array.from({ length: 600 }, () => "same").join("\n")}\n`;
        const harness = createJustBashToolHarness({
            files: { "/workspace/edit.txt": content },
        });
        await harness.runTool(claudeReadTool, { file_path: "/workspace/edit.txt" });

        const args = {
            file_path: "/workspace/edit.txt",
            old_string: "same",
            new_string: "changed",
            replace_all: true,
        };
        const result = await harness.runTool(claudeEditTool, args);
        const presentation = claudeEditTool.toPresentation?.(result, args);
        const file = presentation?.type === "file_diff" ? presentation.files[0] : undefined;

        expect(file).toMatchObject({
            added: 600,
            deleted: 600,
            omittedLines: 700,
        });
        expect(file?.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(500);
    });
});
