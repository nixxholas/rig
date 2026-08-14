import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import {
    commandResultSchema,
    createCommandResult,
    formatCommandResult,
} from "../impl/commandResult.js";

/** How long to wait for an answer after typing, when the model does not say. */
const DEFAULT_WAIT_MS = 250;

/** The longest one call may wait for what it typed to produce something. */
const MAX_WAIT_MS = 30_000;

/** The tool that types into a running command and reads what that produced. */
export function sendCommandInputTool(compute: Compute) {
    return defineAgentTool({
        name: "send_command_input",
        description: `Type into a command that is still running, and read what it says back.

- Use it for prompts and for interactive programs such as a REPL. End a line with a newline, or the program will still be waiting for one.
- Only output produced since the last read is returned.`,
        parameters: Type.Object(
            {
                command_id: Type.Integer({ description: "The ID of the command to type into." }),
                input: Type.String({
                    description: "The characters to send, exactly as typed.",
                }),
                wait_ms: Type.Optional(
                    Type.Integer({
                        description: `How long to wait for a response afterwards. Defaults to ${String(DEFAULT_WAIT_MS)}.`,
                        maximum: MAX_WAIT_MS,
                        minimum: 0,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: commandResultSchema,
        describeAutoPermissionAction: ({ command_id, input }) =>
            `sending ${JSON.stringify(input)} to running command ${String(command_id)}. Access: the command's own input, inside the sandbox it was started in`,
        // Typing into a live program is the program acting, not a lookup, so it is decided on;
        // it needs no elevation, because it reaches nothing the command could not already reach.
        shouldReviewInAutoMode: ({ input }) => input.length > 0,
        execute: async (ctx, { command_id, input, wait_ms }) => {
            const startedAt = Date.now();
            if (!compute.shell.supportsSessionInput) {
                throw new Error("This machine's shell cannot be typed into.");
            }
            const accepted = await compute.shell.writeSession(command_id, input);
            if (!accepted) {
                throw new Error(
                    `Command ${String(command_id)} is not running, so there is nothing to type into.`,
                );
            }
            const snapshot = await compute.shell.readSession(command_id, {
                ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
                waitMs: Math.min(MAX_WAIT_MS, wait_ms ?? DEFAULT_WAIT_MS),
            });
            if (snapshot === undefined) {
                throw new Error(`There is no command ${String(command_id)} on this machine.`);
            }
            return createCommandResult(snapshot, (Date.now() - startedAt) / 1_000);
        },
        isError: (result) => result.exit_code !== undefined && result.exit_code !== 0,
        toLLM: (result) => [{ type: "text", text: formatCommandResult(result) }],
    });
}
