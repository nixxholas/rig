import { Type, type Static } from "@sinclair/typebox";

import type { ComputeSessionSnapshot } from "../Compute.js";
import { boundOutputText } from "./boundOutputText.js";

/** How much of a command's output one answer may carry. */
export const DEFAULT_COMMAND_OUTPUT_TOKENS = 10_000;
export const MAX_COMMAND_OUTPUT_TOKENS = 100_000;
const CHARACTERS_PER_OUTPUT_TOKEN = 4;

/** What every command tool answers with: how the command is doing, and what it has just said. */
export const commandResultSchema = Type.Object({
    command: Type.String(),
    command_id: Type.Optional(
        Type.Integer({
            description:
                "Present while the command is still running. Use it to read its new output, send it input, or stop it.",
        }),
    ),
    exit_code: Type.Optional(
        Type.Union([Type.Integer(), Type.Null()], {
            description:
                "Present once the command has ended. Null when it was stopped by a signal.",
        }),
    ),
    output: Type.String({
        description: "Only what the command has produced since it was last read.",
    }),
    running: Type.Boolean(),
    truncated: Type.Boolean({ description: "Part of the output was too large to be shown." }),
    wall_time_seconds: Type.Number(),
});

export type CommandResult = Static<typeof commandResultSchema>;

/**
 * One command's state as the model reads it.
 *
 * Only new output is carried. The model already has everything it was told before, and handing
 * back the whole log on every read would spend the context on repetition. Two different cuts can
 * shorten that output — the machine's own capture limit while the command was running, and this
 * answer's limit now — and both are stated, because output that quietly goes missing is read as
 * output that never happened.
 */
export function createCommandResult(
    snapshot: ComputeSessionSnapshot,
    wallTimeSeconds: number,
    options: { maxOutputTokens?: number } = {},
): CommandResult {
    const dropped =
        (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0);
    const produced = [snapshot.stdoutDelta, snapshot.stderrDelta]
        .filter((part) => part.length > 0)
        .join("\n");
    const bounded = boundOutputText(produced, {
        maxCharacters:
            (options.maxOutputTokens ?? DEFAULT_COMMAND_OUTPUT_TOKENS) *
            CHARACTERS_PER_OUTPUT_TOKEN,
        keep: "tail",
    });
    const running = snapshot.status === "running";
    return {
        command: snapshot.command,
        ...(running ? { command_id: snapshot.sessionId } : { exit_code: snapshot.exitCode }),
        output:
            dropped === 0
                ? bounded.text
                : `[The machine dropped ${String(dropped)} bytes of this command's output as it ran.]\n${bounded.text}`,
        running,
        truncated: bounded.truncated || dropped > 0,
        wall_time_seconds: Number(wallTimeSeconds.toFixed(3)),
    };
}

/** The same answer as the text the model actually sees. */
export function formatCommandResult(result: CommandResult): string {
    const lines = [`Command: ${result.command}`];
    if (result.running) {
        lines.push(
            `Still running in the background as command ${String(result.command_id ?? 0)}. Read its new output with read_command_output.`,
        );
    } else {
        lines.push(
            result.exit_code === null || result.exit_code === undefined
                ? "The command ended without an exit code, which is what a stopped command looks like."
                : `The command exited with code ${String(result.exit_code)}.`,
        );
    }
    lines.push(`Wall time: ${result.wall_time_seconds.toFixed(2)} seconds`);
    lines.push("Output:", result.output.length > 0 ? result.output : "(no new output)");
    return lines.join("\n");
}
