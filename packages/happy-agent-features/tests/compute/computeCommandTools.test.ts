import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-features-compute-commands");

/** A machine with a scripted shell, and the tools of one agent working on it. */
function machine() {
    const compute = new FakeCompute();
    return { compute, ...computeToolset(ctx, compute) };
}

describe("compute command tools", () => {
    it("runs a command and reports how it ended", async () => {
        const { compute, tool } = machine();
        compute.script("pnpm test", { chunks: ["12 tests passed\n"], exitCode: 0 });

        const result = await tool("run_command").execute(ctx, { command: "pnpm test" });

        expect(result.running).toBe(false);
        expect(result.exit_code).toBe(0);
        expect(result.output).toBe("12 tests passed\n");
        expect(result.command_id).toBeUndefined();
        expect(tool("run_command").isError?.(result)).toBe(false);
    });

    it("reports a command that failed as an error", async () => {
        const { compute, tool } = machine();
        compute.script("pnpm build", { chunks: ["it did not build\n"], exitCode: 1 });

        const result = await tool("run_command").execute(ctx, { command: "pnpm build" });

        expect(tool("run_command").isError?.(result)).toBe(true);
        expect(result.exit_code).toBe(1);
    });

    it("leaves a background command running, and gives only new output on the next read", async () => {
        const { compute, tool } = machine();
        compute.script("pnpm dev", {
            chunks: ["listening on 3000\n", "compiled a change\n"],
            keepRunning: true,
        });

        const started = await tool("run_command").execute(ctx, {
            command: "pnpm dev",
            background: true,
        });

        expect(started.running).toBe(true);
        expect(started.output).toBe("listening on 3000\n");
        expect(started.command_id).toBe(1);
        // Handing back an ID means the command is meant to outlive the call.
        expect(compute.detached.has(1)).toBe(true);

        const again = await tool("read_command_output").execute(ctx, {
            command_id: started.command_id,
            wait_ms: 0,
        });

        // Only what arrived since the first read; the model already has the rest.
        expect(again.output).toBe("compiled a change\n");
        expect(again.running).toBe(true);
    });

    it("types into a running command and reads what that produced", async () => {
        const { compute, tool } = machine();
        compute.script("node --interactive", {
            chunks: ["> "],
            keepRunning: true,
            answer: (input) => `${input.trim()} = 4\n`,
        });
        const started = await tool("run_command").execute(ctx, {
            command: "node --interactive",
            background: true,
        });

        const answered = await tool("send_command_input").execute(ctx, {
            command_id: started.command_id,
            input: "2 + 2\n",
            wait_ms: 0,
        });

        expect(answered.output).toBe("2 + 2 = 4\n");
        expect(answered.running).toBe(true);
    });

    it("stops a running command, and says plainly when there was nothing left to stop", async () => {
        const { compute, tool } = machine();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });
        const started = await tool("run_command").execute(ctx, {
            command: "pnpm dev",
            background: true,
        });

        const stopped = await tool("stop_command").execute(ctx, {
            command_id: started.command_id,
        });
        expect(stopped).toEqual({ command: "pnpm dev", command_id: 1, stopped: true });

        // Repeating the call is harmless, which is what lets the tool be durable.
        const again = await tool("stop_command").execute(ctx, { command_id: started.command_id });
        expect(again.stopped).toBe(false);
    });

    it("says how much of a command's output it left out, and keeps the newest of it", async () => {
        const { compute, tool } = machine();
        compute.script("pnpm noisy", {
            chunks: [`${"noise\n".repeat(9_000)}the last line\n`],
            exitCode: 0,
        });

        const result = await tool("run_command").execute(ctx, { command: "pnpm noisy" });

        expect(result.truncated).toBe(true);
        expect(result.output.startsWith("[Earlier output was truncated")).toBe(true);
        expect(result.output.endsWith("the last line\n")).toBe(true);
    });

    it("tells the model plainly when a command is not there to be read", async () => {
        const { tool } = machine();

        await expect(
            tool("read_command_output").execute(ctx, { command_id: 99, wait_ms: 0 }),
        ).rejects.toThrow(/no command 99/);
    });
});
