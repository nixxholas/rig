/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { boundShellOutput } from "../utils/boundShellOutput.js";
import { parseOptionalTerminalSessionId } from "../utils/parseOptionalTerminalSessionId.js";
import { readSessionWithProgress } from "../utils/readSessionWithProgress.js";
import { sendShellSessionInput } from "../utils/sendShellSessionInput.js";

export const grokSendCommandInputTool = defineTool({
    name: "send_command_input",
    label: "send_command_input",
    description: `Type into a running background command and read what it prints back.

Use it to answer a prompt, drive a REPL, or interrupt with Ctrl-C ("\\u0003"). End a line with a newline, the way you would when typing. Only the output that arrived since your last read comes back.`,
    arguments: Type.Object({
        task_id: Type.String({ description: "Task ID of the running background command." }),
        input: Type.String({
            description:
                'Characters to send. Use "\\u0003" for Ctrl-C, which interrupts without ending the command.',
        }),
        timeout_ms: Type.Optional(
            Type.Integer({
                description: "How long to wait for output afterwards. Defaults to 250ms.",
                maximum: 30_000,
                minimum: 0,
            }),
        ),
    }),
    returnType: Type.Object({
        exit_code: Type.Optional(Type.Number()),
        output: Type.String(),
        status: Type.String(),
        task_id: Type.String(),
    }),
    describeAutoPermissionAction: ({ input, task_id }) =>
        `sending ${quoteVisibleExact(input)} to background command ${task_id}`,
    availableToPermissionReviewer: true,
    shouldReviewInAutoMode: ({ input }) => input.length > 0,
    execute: async ({ input, task_id, timeout_ms = 250 }, context, execution) => {
        const sessionId = parseOptionalTerminalSessionId(task_id);
        if (sessionId === undefined) throw new Error("The background command was not found.");
        if (input.length > 0) await sendShellSessionInput(context.bash, sessionId, input);
        const snapshot = await readSessionWithProgress({
            bash: context.bash,
            ...(execution.onProgress === undefined ? {} : { onProgress: execution.onProgress }),
            sessionId,
            ...(execution.signal === undefined ? {} : { signal: execution.signal }),
            waitMs: Math.max(0, Math.min(30_000, timeout_ms)),
        });
        if (snapshot === undefined) throw new Error("The background command was not found.");
        return {
            ...(snapshot.exitCode === null ? {} : { exit_code: snapshot.exitCode }),
            output: boundShellOutput(
                [snapshot.stdoutDelta, snapshot.stderrDelta]
                    .filter((value) => value.length > 0)
                    .join("\n"),
            ),
            status: snapshot.status,
            task_id,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toPresentation: (result, args) => ({
        command: "",
        input: args.input,
        sessionId: parseOptionalTerminalSessionId(args.task_id) ?? 0,
        type: "background_terminal_interaction",
    }),
    toUI: (result) =>
        result.status === "running"
            ? "Sent input to the background command."
            : "Sent input; the background command has finished.",
    locks: [],
});
