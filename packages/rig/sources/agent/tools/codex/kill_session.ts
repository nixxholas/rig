import { Type } from "@sinclair/typebox";

import { defineTool } from "../../types.js";

export const codexKillSessionTool = defineTool({
    name: "kill_session",
    label: "kill_session",
    description:
        "Stops a running shell session and everything it started. The session is asked to stop first and forced a couple of seconds later.",
    executorTool: {
        name: "kill_session",
        description: "Stops a running unified exec session and every process it started.",
        parameters: Type.Object(
            {
                session_id: Type.Number({
                    description: "Identifier of the unified exec session to stop.",
                }),
            },
            { additionalProperties: false },
        ),
    },
    arguments: Type.Object(
        {
            session_id: Type.Number({
                description: "Identifier of the shell session to stop.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        command: Type.String(),
        message: Type.String(),
        session_id: Type.Number(),
    }),
    describeAutoPermissionAction: ({ session_id }) =>
        `stopping shell session ${String(session_id)}`,
    // Stopping work Rig itself started stays inside our own sandbox, so there
    // is nothing here for a reviewer to weigh.
    shouldReviewInAutoMode: () => false,
    execute: async ({ session_id }, context) => {
        const current = await context.bash.readSession(session_id, { peek: true });
        if (current === undefined) throw new Error("The shell session was not found.");
        if (current.status !== "running") throw new Error("The shell session is not running.");
        const snapshot = await context.bash.killSession(session_id);
        if (snapshot === undefined) throw new Error("The shell session was not found.");
        return {
            command: snapshot.command,
            message: "The shell session was stopped.",
            session_id,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => result.message,
    locks: [],
});
