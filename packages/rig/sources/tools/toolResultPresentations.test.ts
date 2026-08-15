import { describe, expect, it } from "vitest";

import { claudeBashTool } from "../agent/tools/claude/Bash.js";
import { codexExecCommandTool } from "../agent/tools/codex/exec_command.js";
import { grokRunTerminalCommandTool } from "./grok/run_terminal_command.js";
import { createJustBashToolHarness } from "./testing/createJustBashToolHarness.js";
import { parseOptionalTerminalSessionId } from "./utils/parseOptionalTerminalSessionId.js";

describe("tool result presentations", () => {
    it("accepts only canonical terminal session IDs", () => {
        expect(parseOptionalTerminalSessionId("0")).toBe(0);
        expect(parseOptionalTerminalSessionId("42")).toBe(42);
        expect(parseOptionalTerminalSessionId("")).toBeUndefined();
        expect(parseOptionalTerminalSessionId(" 42 ")).toBeUndefined();
        expect(parseOptionalTerminalSessionId("1e2")).toBeUndefined();
        expect(parseOptionalTerminalSessionId("9007199254740992")).toBeUndefined();
    });

    it("presents Claude foreground and background shell results as commands", () => {
        expect(
            claudeBashTool.toPresentation?.(
                {
                    exitCode: 0,
                    stderr: "warning",
                    stdout: "done",
                    timedOut: false,
                },
                { command: "pnpm test" },
            ),
        ).toEqual({
            command: "pnpm test",
            output: "done\nwarning",
            type: "exec_command",
        });

        expect(
            claudeBashTool.toPresentation?.(
                {
                    backgroundTaskId: "42",
                    exitCode: null,
                    stderr: "",
                    stdout: "",
                    timedOut: false,
                },
                { command: "pnpm dev", run_in_background: true },
            ),
        ).toEqual({
            command: "pnpm dev",
            output: "",
            sessionId: 42,
            type: "exec_command",
        });

        expect(
            claudeBashTool.toPresentation?.(
                {
                    backgroundTaskId: "not-a-session",
                    exitCode: null,
                    stderr: "",
                    stdout: "",
                    timedOut: false,
                },
                { command: "pnpm dev", run_in_background: true },
            ),
        ).toEqual({
            command: "pnpm dev",
            output: "",
            type: "exec_command",
        });
    });

    it("keeps a finished exploration command in the shape its call announced", () => {
        const command = "sed -n '1,20p' src/example.ts";
        const context = createJustBashToolHarness().context;
        const callPresentation = claudeBashTool.toCallPresentation?.({ command }, context);

        expect(callPresentation).toEqual({
            operations: [{ kind: "read", name: "example.ts" }],
            type: "exploration",
        });
        expect(
            claudeBashTool.toPresentation?.(
                { exitCode: 0, stderr: "", stdout: "export const needle = 42;", timedOut: false },
                { command },
            ),
        ).toEqual(callPresentation);
        expect(
            codexExecCommandTool.toPresentation?.(
                { exit_code: 0, output: "export const needle = 42;", wall_time_seconds: 0.1 },
                { cmd: command },
            ),
        ).toEqual(callPresentation);
        expect(
            grokRunTerminalCommandTool.toPresentation?.(
                { text: "export const needle = 42;" },
                { background: false, command, description: "Read the example" },
            ),
        ).toEqual(callPresentation);
    });

    it("presents an exploration command that is still running as that command", () => {
        const command = "sed -n '1,20p' src/example.ts";

        expect(
            codexExecCommandTool.toPresentation?.(
                { command, output: "still reading", session_id: 7, wall_time_seconds: 0.1 },
                { cmd: command },
            ),
        ).toEqual({
            command,
            output: "still reading",
            sessionId: 7,
            type: "exec_command",
        });
    });

    it("presents Grok foreground and background shell results as commands", () => {
        expect(
            grokRunTerminalCommandTool.toPresentation?.(
                { text: "done" },
                {
                    background: false,
                    command: "pnpm test",
                    description: "Run tests",
                },
            ),
        ).toEqual({
            command: "pnpm test",
            output: "done",
            type: "exec_command",
        });

        expect(
            grokRunTerminalCommandTool.toPresentation?.(
                {
                    task_id: "43",
                    text: "Background command started with task_id 43.",
                },
                {
                    background: true,
                    command: "pnpm dev",
                    description: "Start development server",
                },
            ),
        ).toEqual({
            command: "pnpm dev",
            output: "",
            sessionId: 43,
            type: "exec_command",
        });

        expect(
            grokRunTerminalCommandTool.toPresentation?.(
                {
                    task_id: "not-a-session",
                    text: "Background command started.",
                },
                {
                    background: true,
                    command: "pnpm dev",
                    description: "Start development server",
                },
            ),
        ).toEqual({
            command: "pnpm dev",
            output: "",
            type: "exec_command",
        });
    });
});
