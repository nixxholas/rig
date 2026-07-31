import { Type, type Static } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { ContentBlock } from "../../agent/types.js";
import { readSessionWithProgress } from "./readSessionWithProgress.js";
import { boundShellOutput } from "./boundShellOutput.js";

const DEFAULT_FOREGROUND_TIMEOUT_MS = 120_000;

/**
 * How long a command explicitly started in the background is watched before we
 * accept that it survived. Long enough to catch a command that falls over
 * immediately, short enough that the model is not left waiting.
 */
export const BACKGROUND_START_GRACE_MS = 3_000;

export const shellToolOutputSchema = Type.Object({
    backgroundTaskId: Type.Optional(Type.String()),
    stdout: Type.String(),
    stderr: Type.String(),
    exitCode: Type.Union([Type.Number(), Type.Null()]),
    timedOut: Type.Boolean(),
});

export interface RunCommandOptions {
    command: string;
    args?: readonly string[];
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    onProgress?: (display: string) => void;
    secrets?: readonly string[];
    signal?: AbortSignal;
    tty?: boolean;
}

export interface RunCommandResult {
    /** Set when the command outlived its wait and kept running in the background. */
    backgroundSessionId?: number;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

/**
 * Runs a command and waits for it, but only for a while.
 *
 * The wait is a wait, not a life expectancy: a command that is still going when
 * the wait runs out keeps running, and the caller gets the session it can come
 * back to. Only an aborted turn kills the command outright.
 */
export async function runShellCommand(
    command: string,
    options: Omit<RunCommandOptions, "command" | "args"> = {},
    context: AgentContext,
): Promise<RunCommandResult> {
    const sessionOptions: Parameters<AgentContext["bash"]["startSession"]>[0] = {
        command,
        cwd: options.cwd ?? context.bash.cwd,
    };
    if (options.maxOutputBytes !== undefined)
        sessionOptions.maxOutputBytes = options.maxOutputBytes;
    if (options.secrets !== undefined) sessionOptions.secrets = options.secrets;
    if (options.tty !== undefined) sessionOptions.tty = options.tty;

    const sessionId = await context.bash.startSession(sessionOptions);
    const abort = () => void context.bash.killSession(sessionId);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
        const snapshot = await readSessionWithProgress({
            bash: context.bash,
            ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
            sessionId,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            waitMs: options.timeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS,
        });
        if (snapshot === undefined) throw new Error("The shell session was not found.");
        // Handing the session back means we intend it to keep running, so an
        // interrupted turn must no longer take it down. An aborted turn hands
        // nothing back, and its command is already on its way out.
        if (snapshot.status === "running" && options.signal?.aborted !== true) {
            context.bash.detachSession?.(sessionId);
        }
        return {
            ...(snapshot.status === "running" ? { backgroundSessionId: sessionId } : {}),
            stdout: snapshot.stdout,
            stderr: snapshot.stderr,
            exitCode: snapshot.exitCode,
            timedOut: snapshot.timedOut,
        };
    } finally {
        options.signal?.removeEventListener("abort", abort);
    }
}

export function toShellToolOutput(result: RunCommandResult): Static<typeof shellToolOutputSchema> {
    return {
        ...(result.backgroundSessionId === undefined
            ? {}
            : { backgroundTaskId: String(result.backgroundSessionId) }),
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
    };
}

export async function runCommand(
    options: RunCommandOptions,
    context: AgentContext,
): Promise<RunCommandResult> {
    const runOptions: Parameters<AgentContext["bash"]["run"]>[0] = {
        command: [options.command, ...(options.args ?? []).map(shellQuote)].join(" "),
        cwd: options.cwd ?? context.bash.cwd,
    };
    if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;
    if (options.maxOutputBytes !== undefined) runOptions.maxOutputBytes = options.maxOutputBytes;
    if (options.secrets !== undefined) runOptions.secrets = options.secrets;
    if (options.signal !== undefined) runOptions.signal = options.signal;
    return context.bash.run(runOptions);
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
        return value;
    }

    return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellOutputToText(
    result: Static<typeof shellToolOutputSchema>,
): readonly ContentBlock[] {
    if (result.backgroundTaskId !== undefined) {
        const output = [
            result.stdout ? `stdout:\n${result.stdout}` : "",
            result.stderr ? `stderr:\n${result.stderr}` : "",
        ]
            .filter((chunk) => chunk.length > 0)
            .join("\n\n");
        return [
            {
                type: "text",
                text: [
                    output.length > 0 ? boundShellOutput(output) : "",
                    `Command still running in background with task ID ${result.backgroundTaskId}. Use TaskOutput to read more of its output, TaskInput to type into it, or TaskStop to stop it.`,
                ]
                    .filter((chunk) => chunk.length > 0)
                    .join("\n\n"),
            },
        ];
    }
    const output = [
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
    ]
        .filter((chunk) => chunk.length > 0)
        .join("\n\n");
    const chunks = [
        output.length > 0 ? boundShellOutput(output) : "",
        `exit_code: ${result.exitCode ?? "null"}`,
        result.timedOut ? "timed_out: true" : "",
    ].filter((chunk) => chunk.length > 0);
    return [{ type: "text", text: chunks.join("\n\n") }];
}
