import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    backgroundTerminalInteractionPresentationSchema,
    execCommandPresentationSchema,
    explorationPresentationSchema,
    fileDiffPresentationSchema,
    searchPresentationSchema,
    toolPresentationSchema,
    type ToolPresentation,
} from "../sources/protocol/messages.js";

const presentations = [
    {
        operations: [
            { kind: "list", target: "sources" },
            { kind: "read", name: "sources/index.ts" },
            {
                command: "Grep Agent",
                kind: "search",
                path: "sources",
                query: "Agent",
            },
        ],
        type: "exploration",
    },
    {
        command: "pnpm test",
        output: "42 passed",
        terminalId: null,
        type: "exec_command",
    },
    {
        command: "pnpm dev",
        input: "y\n",
        terminalId: "terminal1",
        type: "background_terminal_interaction",
    },
    {
        files: [
            {
                added: 1,
                deleted: 1,
                hunks: [
                    {
                        lines: [
                            { kind: "delete", text: "old" },
                            { kind: "add", text: "new" },
                        ],
                        newStart: 12,
                        oldStart: 12,
                    },
                ],
                kind: "update",
                language: "typescript",
                omittedLines: 0,
                path: "sources/index.ts",
            },
        ],
        omittedFiles: 0,
        type: "file_diff",
    },
    {
        query: "thumbhash spec",
        sources: [{ title: "ThumbHash", url: "https://evanw.github.io/thumbhash/" }],
        target: "web",
        type: "search",
    },
] satisfies ToolPresentation[];

describe("tool presentation schemas", () => {
    it("accepts every presentation variant through its own schema and the shared union", () => {
        const schemas = [
            explorationPresentationSchema,
            execCommandPresentationSchema,
            backgroundTerminalInteractionPresentationSchema,
            fileDiffPresentationSchema,
            searchPresentationSchema,
        ];

        expect(
            presentations.map((presentation) => Value.Check(toolPresentationSchema, presentation)),
        ).toEqual([true, true, true, true, true]);
        expect(
            presentations.map((presentation, index) => Value.Check(schemas[index]!, presentation)),
        ).toEqual([true, true, true, true, true]);
    });

    it("rejects unknown variants and malformed bounded counts", () => {
        expect(Value.Check(toolPresentationSchema, { type: "unknown" })).toBe(false);
        expect(
            Value.Check(fileDiffPresentationSchema, {
                files: [
                    {
                        added: -1,
                        deleted: 0,
                        hunks: [],
                        kind: "add",
                        path: "bad.ts",
                    },
                ],
                type: "file_diff",
            }),
        ).toBe(false);
    });
});
