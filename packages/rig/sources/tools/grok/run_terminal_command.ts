/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { summarizeEscalatedShellAction } from "../../permissions/summarizeEscalatedShellAction.js";
import {
    BACKGROUND_START_GRACE_MS,
    parseOptionalTerminalSessionId,
    runShellCommand,
    summarizeTextOutput,
    toTextBlocks,
} from "../utils/index.js";
import { shellExplorationPresentation } from "../utils/shellExplorationPresentation.js";

export const grokRunTerminalCommandTool = defineTool({
    name: "run_terminal_command",
    label: "run_terminal_command",
    description: `Run a bash command and return its output.

Usage notes:
- You can specify an optional timeout in milliseconds, up to 300000. If not specified, foreground commands wait 120000ms. The timeout is how long you wait, not how long the command may live: a command still running when the wait ends keeps running and comes back with a task_id.
- Use background for long-running commands such as development servers and long builds. It waits only long enough to see that the command did not fall over; do not add '&' to the command.
- Read a background command with get_command_or_subagent_output, type into it with send_command_input, and stop it with kill_command_or_subagent. You are told when a background command ends on its own.
- Output may be truncated before it is returned.`,
    arguments: Type.Object({
        command: Type.String({ description: "The bash command to run." }),
        timeout: Type.Optional(
            Type.Integer({
                description:
                    "Optional timeout in milliseconds (max 300000). Default: 120000. A timeout of 0 disables the timeout for background commands.",
                maximum: 300_000,
                minimum: 0,
            }),
        ),
        description: Type.String({
            description:
                "One sentence explaining why this command needs to run and how it contributes to the goal.",
        }),
        secrets: Type.Optional(
            Type.Array(Type.String(), {
                description:
                    "IDs of attached secret bundles to inject for this command. Use an empty array for none.",
            }),
        ),
        tty: Type.Optional(
            Type.Boolean({
                description:
                    "Run the command under a terminal, for programs that behave differently without one. Defaults to false.",
            }),
        ),
        background: Type.Boolean({
            description:
                "Set true for a long-running command. Returns a task_id while the command continues in the background.",
        }),
        sandbox_permissions: Type.Optional(
            Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
                description:
                    "Request reviewed execution outside the workspace sandbox in Auto mode. Defaults to use_default.",
            }),
        ),
    }),
    returnType: Type.Object({
        text: Type.String(),
        task_id: Type.Optional(Type.String()),
    }),
    autoPermissionInstructions:
        'For run_terminal_command, request full-access execution with sandbox_permissions: "require_escalated". Explain why in the description. Keep sandbox_permissions at "use_default" or omit it for ordinary commands.',
    describeAutoPermissionAction: ({ command }, context) =>
        summarizeEscalatedShellAction({ command, cwd: context.fs.cwd }),
    availableToPermissionReviewer: true,
    shouldReviewInAutoMode: ({ sandbox_permissions }) =>
        sandbox_permissions === "require_escalated",
    shouldRunInFullAccessInAutoMode: ({ sandbox_permissions }) =>
        sandbox_permissions === "require_escalated",
    execute: async ({ background, command, secrets, timeout, tty }, context, execution) => {
        const options: Parameters<typeof runShellCommand>[1] = { maxOutputBytes: 512_000 };
        if (secrets !== undefined) options.secrets = secrets;
        if (tty !== undefined) options.tty = tty;
        options.timeoutMs = background
            ? BACKGROUND_START_GRACE_MS
            : timeout === undefined || timeout === 0
              ? 120_000
              : timeout;
        if (execution.onProgress !== undefined) options.onProgress = execution.onProgress;
        if (execution.signal !== undefined) options.signal = execution.signal;

        const result = await runShellCommand(command, options, context);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        if (result.backgroundSessionId !== undefined) {
            const taskId = String(result.backgroundSessionId);
            return {
                task_id: taskId,
                text: [
                    output,
                    `Command still running in the background with task_id ${taskId}. Read it with get_command_or_subagent_output, type into it with send_command_input, or stop it with kill_command_or_subagent.`,
                ]
                    .filter(Boolean)
                    .join("\n\n"),
            };
        }
        const text = output || "(no output)";
        if (result.exitCode !== null && result.exitCode !== 0) {
            throw new Error(`${text}\n\nCommand exited with code ${result.exitCode}.`);
        }
        return { text };
    },
    toCallPresentation: ({ background, command }) =>
        shellExplorationPresentation({ background, command }) ?? {
            command,
            type: "exec_command",
        },
    toPresentation: (result, { background, command }) => {
        const sessionId = parseOptionalTerminalSessionId(result.task_id);
        return (
            shellExplorationPresentation({
                background,
                command,
                ...(sessionId === undefined ? {} : { sessionId }),
            }) ?? {
                command,
                output: background ? "" : result.text,
                ...(sessionId === undefined ? {} : { sessionId }),
                type: "exec_command",
            }
        );
    },
    toLLM: (result) => toTextBlocks({ text: result.text }),
    toUI: (result) => summarizeTextOutput(result.text),
    locks: [],
});
