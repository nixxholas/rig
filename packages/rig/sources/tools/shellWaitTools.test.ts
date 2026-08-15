import { describe, expect, it } from "vitest";

import { claudeTaskInputTool } from "../agent/tools/claude/TaskInput.js";
import { codexExecCommandTool } from "../agent/tools/codex/exec_command.js";
import { codexWriteStdinTool } from "../agent/tools/codex/write_stdin.js";
import { grokRunTerminalCommandTool } from "./grok/run_terminal_command.js";
import { grokSendCommandInputTool } from "./grok/send_command_input.js";

describe("provider shell wait tools", () => {
    it.each([
        ["Claude TaskInput", claudeTaskInputTool],
        ["Codex exec_command", codexExecCommandTool],
        ["Codex write_stdin", codexWriteStdinTool],
        ["Grok run_terminal_command", grokRunTerminalCommandTool],
        ["Grok send_command_input", grokSendCommandInputTool],
    ])("allows steering to interrupt %s waits", (_name, tool) => {
        expect(tool.steerable).toBe(true);
    });
});
