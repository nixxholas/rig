import { Type } from "@sinclair/typebox";

import { defineTool } from "../../types.js";
import { quoteVisibleExact } from "../../../permissions/quoteVisibleExact.js";
import { parseBackgroundTaskId } from "../../../tools/claude/parseBackgroundTaskId.js";
import { boundShellOutput } from "../../../tools/utils/boundShellOutput.js";
import { readSessionWithProgress } from "../../../tools/utils/readSessionWithProgress.js";
import { sendShellSessionInput } from "../../../tools/utils/sendShellSessionInput.js";

export const claudeTaskInputTool = defineTool({
    name: "TaskInput",
    label: "TaskInput",
    description: `Type into a running background shell task and read what it prints back.

Use it to answer a prompt, drive a REPL, or interrupt with Ctrl-C ("\\u0003"). End a line with a newline, the way you would when typing. Only the output that arrived since your last read comes back.`,
    arguments: Type.Object(
        {
            task_id: Type.String({ description: "The background task identifier." }),
            input: Type.String({
                description:
                    'Characters to send. Use "\\u0003" for Ctrl-C, which interrupts without ending the task.',
            }),
            timeout: Type.Optional(
                Type.Number({
                    default: 250,
                    description: "How long to wait for output afterwards, in milliseconds.",
                    maximum: 30_000,
                    minimum: 0,
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        exitCode: Type.Union([Type.Number(), Type.Null()]),
        output: Type.String(),
        status: Type.Union([
            Type.Literal("completed"),
            Type.Literal("killed"),
            Type.Literal("running"),
        ]),
        task_id: Type.String(),
    }),
    describeAutoPermissionAction: ({ input, task_id }) =>
        `sending ${quoteVisibleExact(input)} to background command ${task_id}`,
    availableToPermissionReviewer: true,
    shouldReviewInAutoMode: ({ input }) => input.length > 0,
    shouldRunInFullAccessInAutoMode: ({ input, task_id }, context) =>
        input.length > 0 && secretTask(task_id, context.bash?.sessionUsesSecrets),
    steerable: true,
    execute: async ({ input, task_id, timeout = 250 }, context, execution) => {
        const sessionId = parseBackgroundTaskId(task_id);
        if (input.length > 0) await sendShellSessionInput(context.bash, sessionId, input);
        const snapshot = await readSessionWithProgress({
            bash: context.bash,
            ...(execution.onProgress === undefined ? {} : { onProgress: execution.onProgress }),
            sessionId,
            ...(execution.signal === undefined ? {} : { signal: execution.signal }),
            waitMs: Math.max(0, Math.min(30_000, timeout)),
        });
        if (snapshot === undefined) throw new Error("The background task was not found.");
        return {
            exitCode: snapshot.exitCode,
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
        sessionId: parseBackgroundTaskId(args.task_id),
        type: "background_terminal_interaction",
    }),
    toUI: (result) =>
        result.status === "running"
            ? "Sent input to the background command."
            : "Sent input; the background command has finished.",
    locks: [],
});

function secretTask(
    taskId: string,
    sessionUsesSecrets: ((sessionId: number) => boolean) | undefined,
): boolean {
    try {
        return sessionUsesSecrets?.(parseBackgroundTaskId(taskId)) === true;
    } catch {
        return false;
    }
}
