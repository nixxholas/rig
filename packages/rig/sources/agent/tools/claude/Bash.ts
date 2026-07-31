import { Type } from "@sinclair/typebox";

import { defineTool } from "../../types.js";
import { summarizeEscalatedShellAction } from "../../../permissions/summarizeEscalatedShellAction.js";
import {
    BACKGROUND_START_GRACE_MS,
    SHELL_CAPTURE_MAX_BYTES,
    SHELL_OUTPUT_MAX_BYTES,
    SHELL_OUTPUT_MAX_LINES,
    parseOptionalTerminalSessionId,
    runShellCommand,
    shellOutputToText,
    shellToolOutputSchema,
    summarizeShellOutput,
    toShellToolOutput,
} from "../../../tools/utils/index.js";
import { shellExplorationPresentation } from "../../../tools/utils/shellExplorationPresentation.js";

export const claudeBashTool = defineTool({
    name: "Bash",
    label: "Bash",
    description: `Executes a bash command and returns its output.

- Commands start in the session working directory. Shell state (such as \`cd\`, environment variables, and functions) does not persist between calls.
- Try to maintain the current working directory by using absolute paths and avoiding usage of \`cd\`. In particular, never prepend \`cd <current-directory>\` to a \`git\` command: Git already operates on the current working tree, and making it a compound command can trigger an unnecessary permission review.
- Prefer the dedicated file and search tools over shell equivalents when one fits.
- \`timeout\` is in milliseconds: default 120000, max 600000. It is how long you wait, not how long the command may live: a command still running when the wait ends keeps running in the background and comes back with a task ID.
- \`run_in_background\` starts the command in the background right away, waiting only long enough to see that it did not fall over. Use it for dev servers and watchers. No \`&\` needed.
- Read a background task with \`TaskOutput\`, type into it with \`TaskInput\`, and stop it with \`TaskStop\`. You are told when a background task ends on its own.

# Git
- Interactive flags such as \`git rebase -i\` and \`git add -i\` are not supported.
- Use the \`gh\` CLI for GitHub operations.
- Commit or push only when the user asks.

Rig extension: \`secrets\` injects selected session secret bundles. \`dangerouslyDisableSandbox\` requests one reviewed full-access execution in Auto mode; it never bypasses Read only or Workspace write mode.

Output is truncated to the last ${SHELL_OUTPUT_MAX_LINES} lines or ${SHELL_OUTPUT_MAX_BYTES / 1024}KB.`,
    arguments: Type.Object(
        {
            command: Type.String({ description: "The command to execute" }),
            timeout: Type.Optional(
                Type.Number({
                    description: "Optional timeout in milliseconds (max 600000)",
                    maximum: 600_000,
                    minimum: 0,
                }),
            ),
            description: Type.Optional(
                Type.String({
                    description:
                        'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description.',
                }),
            ),
            run_in_background: Type.Optional(
                Type.Boolean({
                    description: "Set to true to run this command in the background.",
                }),
            ),
            tty: Type.Optional(
                Type.Boolean({
                    description:
                        "Run the command under a terminal, for programs that behave differently without one. Defaults to false.",
                }),
            ),
            secrets: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        "IDs of attached secret bundles to inject for this command. Use an empty array for none.",
                }),
            ),
            dangerouslyDisableSandbox: Type.Optional(
                Type.Boolean({
                    description:
                        "Request reviewed execution outside the workspace sandbox in Auto mode. Use only when the sandbox blocks a necessary command.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: shellToolOutputSchema,
    autoPermissionInstructions:
        "For Bash, request full-access execution with dangerouslyDisableSandbox: true only when the workspace sandbox blocks necessary work. The command remains sandboxed when this field is false or omitted.",
    describeAutoPermissionAction: ({ command }, context) =>
        summarizeEscalatedShellAction({ command, cwd: context.fs.cwd }),
    availableToPermissionReviewer: true,
    shouldReviewInAutoMode: ({ dangerouslyDisableSandbox }) => dangerouslyDisableSandbox === true,
    shouldRunInFullAccessInAutoMode: ({ dangerouslyDisableSandbox }) =>
        dangerouslyDisableSandbox === true,
    execute: async ({ command, run_in_background, secrets, timeout, tty }, context, execution) => {
        const options: Parameters<typeof runShellCommand>[1] = {
            maxOutputBytes: SHELL_CAPTURE_MAX_BYTES,
        };
        if (secrets !== undefined) options.secrets = secrets;
        if (tty !== undefined) options.tty = tty;
        if (run_in_background === true) options.timeoutMs = BACKGROUND_START_GRACE_MS;
        else if (timeout !== undefined) options.timeoutMs = timeout;
        if (execution.onProgress !== undefined) options.onProgress = execution.onProgress;
        if (execution.signal !== undefined) options.signal = execution.signal;
        return toShellToolOutput(await runShellCommand(command, options, context));
    },
    toCallPresentation: ({ command, run_in_background }) =>
        shellExplorationPresentation({ background: run_in_background === true, command }) ?? {
            command,
            type: "exec_command",
        },
    toPresentation: (result, { command, run_in_background }) => {
        const sessionId = parseOptionalTerminalSessionId(result.backgroundTaskId);
        return (
            shellExplorationPresentation({
                background: run_in_background === true,
                command,
                ...(sessionId === undefined ? {} : { sessionId }),
            }) ?? {
                command,
                output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
                ...(sessionId === undefined ? {} : { sessionId }),
                type: "exec_command",
            }
        );
    },
    toLLM: shellOutputToText,
    toUI: (result) => summarizeShellOutput(result),
    locks: [],
});
