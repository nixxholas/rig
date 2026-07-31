import { describe, expect, it } from "vitest";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { claudeBashTool } from "../../agent/tools/claude/Bash.js";
import { claudeTaskOutputTool } from "../../agent/tools/claude/TaskOutput.js";
import { claudeTaskStopTool } from "../../agent/tools/claude/TaskStop.js";

describe("Claude Code Bash tool", () => {
    it("tells Claude not to redundantly change to the current working directory", () => {
        expect(claudeBashTool.description).toContain("avoiding usage of `cd`");
        expect(claudeBashTool.description).toContain(
            "never prepend `cd <current-directory>` to a `git` command",
        );
    });

    it("allows steering to interrupt passive task-output waits", () => {
        expect(claudeTaskOutputTool.steerable).toBe(true);
    });

    it("executes commands through the agent context bash", async () => {
        const harness = createJustBashToolHarness();
        const progress: string[] = [];
        const readSession = harness.context.bash.readSession.bind(harness.context.bash);
        const startSession = harness.context.bash.startSession.bind(harness.context.bash);
        let observedWaitMs = 0;
        let observedMaxOutputBytes: number | undefined;
        harness.context.bash.startSession = (options) => {
            observedMaxOutputBytes = options.maxOutputBytes;
            return startSession(options);
        };
        harness.context.bash.readSession = (sessionId, readOptions) => {
            observedWaitMs = Math.max(observedWaitMs, readOptions?.waitMs ?? 0);
            return readSession(sessionId, readOptions);
        };

        const result = await claudeBashTool.execute(
            { command: "echo claude > note.txt && cat note.txt" },
            harness.context,
            { onProgress: (display) => progress.push(display) },
        );

        expect(result.stdout).toBe("claude\n");
        expect(await harness.readFile("/workspace/note.txt")).toBe("claude\n");
        expect(progress).toContain("claude\n");
        // The default 120s is how long we wait, and the command is never
        // given a deadline of its own.
        expect(observedWaitMs).toBeGreaterThan(0);
        expect(observedMaxOutputBytes).toBe(512_000);
    });

    it("returns only a 50KB tail to Claude for large foreground output", async () => {
        const harness = createJustBashToolHarness();
        const result = await claudeBashTool.execute(
            {
                command: `printf 'old-head-'; printf '%060000d' 0; printf '%s' '-new-tail'`,
            },
            harness.context,
            {},
        );
        const rendered = claudeBashTool.toLLM(result);
        const text = rendered[0]?.type === "text" ? rendered[0].text : "";

        expect(Buffer.byteLength(text, "utf8")).toBeLessThan(52_000);
        expect(text).not.toContain("old-head");
        expect(text).toContain("new-tail");
        expect(text).toContain("Earlier output was truncated");
    });

    it("runs commands in the background and retrieves their output", async () => {
        const harness = createJustBashToolHarness();

        // Still running when the short background wait ends, so it comes back
        // as a task rather than a finished command.
        const started = await harness.runTool(claudeBashTool, {
            command: "sleep 5; echo background-complete",
            run_in_background: true,
        });
        const taskId = started.backgroundTaskId;
        expect(taskId).toBeDefined();
        expect(started.exitCode).toBeNull();

        await expect(
            harness.runTool(claudeTaskOutputTool, {
                block: false,
                task_id: taskId as string,
            }),
        ).resolves.toMatchObject({ retrieval_status: "not_ready" });

        const output = await harness.runTool(claudeTaskOutputTool, {
            block: true,
            task_id: taskId as string,
            timeout: 8_000,
        });
        expect(output).toMatchObject({
            retrieval_status: "success",
            task: {
                output: "background-complete\n",
                status: "completed",
                task_id: taskId,
                task_type: "local_bash",
            },
        });
        await expect(
            harness.runTool(claudeTaskStopTool, { task_id: taskId as string }),
        ).rejects.toThrow("not running");
    }, 20_000);

    it("bounds large background command output before returning it to Claude", async () => {
        const harness = createJustBashToolHarness();
        // Outlives the short background wait, so its output is collected by a
        // later read rather than by the starting call.
        const started = await harness.runTool(claudeBashTool, {
            command: "printf 'old-head-'; printf '%060000d' 0; printf '%s' '-new-tail'; sleep 4",
            run_in_background: true,
        });
        const taskId = started.backgroundTaskId;
        expect(taskId).toBeDefined();

        const output = await harness.runTool(claudeTaskOutputTool, {
            block: true,
            task_id: taskId as string,
            timeout: 8_000,
        });
        const taskOutput = output.task?.task_type === "local_bash" ? output.task.output : "";

        expect(Buffer.byteLength(taskOutput, "utf8")).toBeLessThan(52_000);
        expect(taskOutput).not.toContain("old-head");
        expect(taskOutput).toContain("new-tail");
        expect(taskOutput).toContain("Earlier output was truncated");

        // A second read brings back nothing, because nothing else arrived.
        const again = await harness.runTool(claudeTaskOutputTool, {
            block: false,
            task_id: taskId as string,
        });
        expect(again.task?.task_type === "local_bash" ? again.task.output : "").toBe("");
    }, 20_000);

    it("never gives a command a deadline of its own", async () => {
        const harness = createJustBashToolHarness();
        const startSession = harness.context.bash.startSession.bind(harness.context.bash);
        const observedTimeouts: (number | undefined)[] = [];
        harness.context.bash.startSession = (options) => {
            observedTimeouts.push(options.timeoutMs);
            return startSession(options);
        };

        const started = await harness.runTool(claudeBashTool, {
            command: "sleep 30",
            run_in_background: true,
        });
        await harness.runTool(claudeBashTool, { command: "echo quick", timeout: 5_000 });

        await harness.runTool(claudeTaskStopTool, {
            task_id: started.backgroundTaskId as string,
        });
        expect(observedTimeouts).toEqual([undefined, undefined]);
    });

    it("stops a running background command", async () => {
        const harness = createJustBashToolHarness();
        const started = await harness.runTool(claudeBashTool, {
            command: "sleep 30",
            run_in_background: true,
        });
        const taskId = started.backgroundTaskId;
        expect(taskId).toBeDefined();

        await expect(
            harness.runTool(claudeTaskStopTool, { task_id: taskId as string }),
        ).resolves.toMatchObject({
            message: "The background command was stopped.",
            task_id: taskId,
        });
    });
});
