import { describe, expect, it } from "vitest";

import { grokReadFileTool } from "../../agent/tools/grok/read_file.js";
import { grokSearchReplaceTool } from "../../agent/tools/grok/search_replace.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";

describe("Grok search_replace tool", () => {
    it("presents the resulting file diff", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/edit.txt": "before\n" },
        });
        await harness.runTool(grokReadFileTool, { target_file: "/workspace/edit.txt" });

        const args = {
            file_path: "/workspace/edit.txt",
            new_string: "after",
            old_string: "before",
        };
        const result = await harness.runTool(grokSearchReplaceTool, args);

        expect(grokSearchReplaceTool.toPresentation?.(result, args)).toMatchObject({
            files: [
                {
                    hunks: [
                        {
                            lines: [
                                { kind: "delete", text: "before" },
                                { kind: "add", text: "after" },
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
    });
});
