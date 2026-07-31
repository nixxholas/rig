import type { BashSessionExit } from "../agent/context/BashContext.js";

/**
 * Says that a background command ended, and nothing else.
 *
 * The output stays where it is; the model reads it when it wants it.
 */
export function formatBackgroundProcessExit(exit: BashSessionExit): string {
    const ending =
        exit.status === "killed"
            ? "was stopped"
            : exit.exitCode === 0
              ? "finished successfully"
              : exit.exitCode === null
                ? "ended"
                : `failed with exit code ${String(exit.exitCode)}`;
    return `Background command ${String(exit.sessionId)} (${summarizeCommand(exit.command)}) ${ending}. Its remaining output is still available to read.`;
}

/**
 * A command is whatever the model wrote, and that can be a whole script.
 * The notice exists to name which command ended, so one line is enough.
 */
function summarizeCommand(command: string): string {
    const trimmed = command.trim();
    const line = trimmed.split("\n", 1)[0] ?? "";
    if (line.length > MAX_COMMAND_LENGTH) return `${line.slice(0, MAX_COMMAND_LENGTH)}…`;
    return line === trimmed ? line : `${line}…`;
}

const MAX_COMMAND_LENGTH = 120;
