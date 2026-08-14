import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";

/** The tool that ends a running command and everything it started. */
export function stopCommandTool(compute: Compute) {
    return defineAgentTool({
        name: "stop_command",
        description: `Stop a command that is still running, along with everything it started.

- The command is asked to stop first and forced a moment later.
- Stopping a command that has already ended is not an error; you are simply told it had ended.`,
        parameters: Type.Object(
            { command_id: Type.Integer({ description: "The ID of the command to stop." }) },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            command: Type.String(),
            command_id: Type.Integer(),
            stopped: Type.Boolean({
                description: "False when the command had already ended by itself.",
            }),
        }),
        // Stopping something already stopped stops nothing, so a repeated call is harmless.
        durable: true,
        // Ending work Rig itself started stays inside the machine the agent already has.
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, { command_id }) => {
            const current = await compute.shell.readSession(command_id, { peek: true });
            if (current === undefined) {
                throw new Error(`There is no command ${String(command_id)} on this machine.`);
            }
            if (current.status !== "running") {
                return { command: current.command, command_id, stopped: false };
            }
            const stopped = await compute.shell.killSession(command_id);
            return {
                command: stopped?.command ?? current.command,
                command_id,
                stopped: true,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: result.stopped
                    ? `Stopped command ${String(result.command_id)}: ${result.command}`
                    : `Command ${String(result.command_id)} had already ended: ${result.command}`,
            },
        ],
    });
}
