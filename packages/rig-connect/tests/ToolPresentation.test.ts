import { describe, expect, it } from "vitest";

import { projectToolPresentation } from "@/ToolPresentation.js";
import type { ToolCallPresentation, ToolResultPresentation } from "@/protocol.js";

describe("projectToolPresentation", () => {
    it("describes a running command with what is known so far", () => {
        const call: ToolCallPresentation = { command: "ls -la", type: "exec_command" };

        expect(projectToolPresentation(call, undefined)).toEqual({
            command: "ls -la",
            kind: "command",
        });
    });

    it("joins a command and its output into the one value that started running", () => {
        const call: ToolCallPresentation = { command: "ls -la", type: "exec_command" };
        const result: ToolResultPresentation = {
            command: "ls -la",
            output: "3 files",
            type: "exec_command",
        };

        // The wire describes these as two unrelated shapes. A reader sees one
        // command that gained its output, so the kind must not change.
        expect(projectToolPresentation(call, result)).toEqual({
            command: "ls -la",
            kind: "command",
            output: "3 files",
        });
    });

    it("prefers the result, which is the later and fuller account", () => {
        const call: ToolCallPresentation = { command: "stale", type: "exec_command" };
        const result: ToolResultPresentation = {
            command: "actual",
            output: "done",
            type: "exec_command",
        };

        expect(projectToolPresentation(call, result)).toMatchObject({ command: "actual" });
    });

    it("carries the terminal a command belongs to", () => {
        const result: ToolResultPresentation = {
            command: "npm test",
            output: "ok",
            sessionId: 4,
            type: "exec_command",
        };

        expect(projectToolPresentation(undefined, result)).toMatchObject({ terminalId: 4 });
    });

    it("distinguishes input sent to a running terminal from a command", () => {
        const result: ToolResultPresentation = {
            command: "python",
            input: "print(1)",
            sessionId: 2,
            type: "background_terminal_interaction",
        };

        expect(projectToolPresentation(undefined, result)).toEqual({
            command: "python",
            input: "print(1)",
            kind: "terminal_input",
            terminalId: 2,
        });
    });

    it("presents a file edit as its diff", () => {
        const result: ToolResultPresentation = {
            files: [{ hunks: [], kind: "update", path: "a.ts" }],
            omittedFiles: 1,
            type: "file_diff",
        };

        expect(projectToolPresentation(undefined, result)).toEqual({
            files: [{ hunks: [], kind: "update", path: "a.ts" }],
            kind: "file_edit",
            omittedFiles: 1,
        });
    });

    it("keeps each exploration step in the terms the daemon reported", () => {
        const call: ToolCallPresentation = {
            operations: [
                { kind: "list", target: "sources" },
                { kind: "read", name: "ChatStore.ts" },
                { command: "rg todo sources", kind: "search", path: "sources", query: "todo" },
            ],
            type: "exploration",
        };

        // Wording belongs to the interface. Folding these into a phrase here
        // would lose the query and the command a UI may want to show.
        expect(projectToolPresentation(call, undefined)).toEqual({
            kind: "exploration",
            steps: [
                { kind: "list", target: "sources" },
                { kind: "read", name: "ChatStore.ts" },
                { command: "rg todo sources", kind: "search", path: "sources", query: "todo" },
            ],
        });
    });

    it("keeps the command of a search that named neither query nor path", () => {
        const call: ToolCallPresentation = {
            operations: [{ command: "rg --files", kind: "search" }],
            type: "exploration",
        };

        // A consumer choosing what to show still has the command to fall back
        // on, which a phrased summary would have discarded.
        expect(projectToolPresentation(call, undefined)).toEqual({
            kind: "exploration",
            steps: [{ command: "rg --files", kind: "search" }],
        });
    });

    it("says nothing rather than guessing at a kind it does not know", () => {
        // A newer daemon must not break an older client. The consumer keeps the
        // plain result text as its fallback.
        expect(projectToolPresentation({ type: "invented" } as never, undefined)).toBeUndefined();
        expect(projectToolPresentation(undefined, { type: "invented" } as never)).toBeUndefined();
    });

    it("presents nothing when Rig described nothing", () => {
        expect(projectToolPresentation(undefined, undefined)).toBeUndefined();
    });

    it("falls back to the call when the result kind is unknown", () => {
        const call: ToolCallPresentation = { command: "ls", type: "exec_command" };

        // A result this library cannot read must not erase what the call already
        // said, which is still true and still worth showing.
        expect(projectToolPresentation(call, { type: "invented" } as never)).toEqual({
            command: "ls",
            kind: "command",
        });
    });
});
