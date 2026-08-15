import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import {
    commandResultSchema,
    createCommandResult,
    formatCommandResult,
} from "../impl/commandResult.js";

/** How long a read waits for something to arrive when the model does not say. */
const DEFAULT_WAIT_MS = 5_000;

/** The longest one read may wait. */
const MAX_WAIT_MS = 300_000;

/** The tool that collects what a background command has produced since the last read. */
export function readCommandOutputTool(compute: Compute) {
    return defineAgentTool({
        name: "read_command_output",
        description: `Read what a background command has produced since you last read it.

- Only new output is returned; what you were told before is not repeated.
- A command that has ended keeps answering this for a while, so its last output is never lost.`,
        parameters: Type.Object(
            {
                command_id: Type.Integer({ description: "The ID of the command to read." }),
                wait_ms: Type.Optional(
                    Type.Integer({
                        description: `How long to wait for output before answering. Defaults to ${String(DEFAULT_WAIT_MS)}.`,
                        maximum: MAX_WAIT_MS,
                        minimum: 0,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: commandResultSchema,
        // Deliberately not durable: a read consumes what it returns, so repeating one after a
        // restart would answer with nothing and lose the output the first call was carrying.
        // Reading output of work Rig itself started stays inside the machine the agent already
        // has, so there is nothing here for a reviewer to weigh.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { command_id, wait_ms }) => {
            const startedAt = Date.now();
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
