import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import {
    commandResultSchema,
    createCommandResult,
    formatCommandResult,
} from "../impl/commandResult.js";

/** How long a command is waited for when the model does not say. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** The longest wait a model may ask for. Beyond this it should background the command instead. */
const MAX_TIMEOUT_MS = 600_000;

/**
 * How long a command started in the background is watched before the tool answers. Long enough
 * to catch one that falls over immediately, short enough that starting a server feels instant.
 */
const BACKGROUND_GRACE_MS = 3_000;

/** How much of a command's output the machine captures while it runs. */
const CAPTURE_MAX_BYTES = 512_000;

/** The tool that runs a shell command, and leaves it running when it outlasts the wait. */
export function runCommandTool(compute: Compute) {
    return defineAgentTool({
        name: "run_command",
        description: `Run a shell command on the machine you are working on.

- Commands start in the working directory, and nothing carries over between calls: a directory change or a variable set by one command is gone by the next.
- Reaching the timeout does not kill the command. It keeps running in the background and comes back with a command ID.
- Use background for work meant to outlive the call, such as a dev server or a watcher. It waits about ${String(BACKGROUND_GRACE_MS / 1_000)} seconds to see that the command did not fall over, then answers.
- A running command is read with read_command_output, typed into with send_command_input, and ended with stop_command. Each read returns only what is new.
- Prefer read_file, list_directory, find_files, and search_files over their shell equivalents.`,
        parameters: Type.Object(
            {
                command: Type.String({ description: "The command to run." }),
                workdir: Type.Optional(
                    Type.String({
                        description:
                            "The directory to run it in. Defaults to the working directory.",
                    }),
                ),
                timeout_ms: Type.Optional(
                    Type.Integer({
                        description: `How long to wait before the command is left running in the background. Defaults to ${String(DEFAULT_TIMEOUT_MS)}.`,
                        maximum: MAX_TIMEOUT_MS,
                        minimum: 0,
                    }),
                ),
                background: Type.Optional(
                    Type.Boolean({
                        description:
                            "Start the command in the background straight away. Defaults to false.",
                    }),
                ),
                tty: Type.Optional(
                    Type.Boolean({
                        description:
                            "Run under a terminal, for programs that behave differently without one. Defaults to false.",
                    }),
                ),
                escalate_sandbox: Type.Optional(
                    Type.Boolean({
                        description:
                            "Ask for this one command to be reviewed and run outside the workspace sandbox. Defaults to false.",
                    }),
                ),
                justification: Type.Optional(
                    Type.String({
                        description:
                            "A short, concrete reason the sandbox has to be left. Use it only with escalate_sandbox.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: commandResultSchema,
        autoPermissionInstructions:
            "Set escalate_sandbox to true, with a concise justification, only when the workspace sandbox is what stops a command from doing necessary work. Every other command runs sandboxed.",
        describeAutoPermissionAction: ({ command, workdir, justification }) =>
            `running ${JSON.stringify(command)} in ${JSON.stringify(workdir ?? compute.cwd)} outside the workspace sandbox, with unrestricted filesystem and network access${
                justification === undefined ? "" : `. Reason given: ${justification}`
            }`,
        // A sandboxed command is the ordinary case and needs no reviewer; leaving the sandbox is
        // the whole of what one is asked about here.
        shouldReviewInAutoMode: ({ escalate_sandbox }) => escalate_sandbox === true,
        shouldRunInFullAccessInAutoMode: ({ escalate_sandbox }) => escalate_sandbox === true,
        execute: async (ctx, { command, workdir, timeout_ms, background, tty }) => {
            const startedAt = Date.now();
            const sessionId = await compute.shell.startSession({
                command,
                ...(workdir === undefined ? {} : { cwd: workdir }),
                maxOutputBytes: CAPTURE_MAX_BYTES,
                ...(tty === undefined ? {} : { tty }),
            });
            // A command the model asked to keep is already the turn's own business; one it is
            // waiting on is not, so cancelling the turn takes that one down with it.
            const stop = () => void compute.shell.killSession(sessionId);
            const watching = background !== true ? ctx.lifetime : undefined;
            watching?.addEventListener("abort", stop, { once: true });
            if (watching?.aborted === true) stop();
            let snapshot;
            try {
                snapshot = await compute.shell.readSession(sessionId, {
                    ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
                    waitMs:
                        background === true
                            ? BACKGROUND_GRACE_MS
                            : Math.min(MAX_TIMEOUT_MS, timeout_ms ?? DEFAULT_TIMEOUT_MS),
                });
            } finally {
                watching?.removeEventListener("abort", stop);
            }
            if (snapshot === undefined) throw new Error("The command could not be started.");
            // Handing back a command ID means the command is meant to go on running, so an
            // interrupted turn must no longer take it down.
            if (snapshot.status === "running" && ctx.lifetime?.aborted !== true) {
                compute.shell.detachSession?.(sessionId);
            }
            return createCommandResult(snapshot, (Date.now() - startedAt) / 1_000);
        },
        isError: (result) => result.exit_code !== undefined && result.exit_code !== 0,
        toLLM: (result) => [{ type: "text", text: formatCommandResult(result) }],
    });
}
