import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterAll, describe, expect, it } from "vitest";

import { createRealGym, type RealGym } from "./createRealGym.js";
import type { RealGymVendor } from "./loadRealProvider.js";
import { RealGymTraces, toolCallsOf } from "./RealGymTrace.js";
import { writeRealGymReport } from "./renderRealGymReport.js";

const ctx = createRootContext().named("real-gym");
const traces = new RealGymTraces();
const REPORT = join(import.meta.dirname, "../../.context/real-gym/report.html");

/** Live inference costs real tokens, so it runs only when it is asked for by name. */
const live = process.env.RIG_LIVE_TEST === "1";

/** Each vendor's flagship model, addressed by its Rig ID. */
const VENDORS: readonly { vendor: RealGymVendor; model: string }[] = [
    { vendor: "codex", model: "openai/gpt-5.6-sol" },
    { vendor: "claude", model: "anthropic/sonnet-5" },
];

afterAll(async () => {
    if (traces.traces.length === 0) return;
    const path = await writeRealGymReport(REPORT, traces.traces);
    console.log(`Real gym report: ${path}`);
});

/** Run one scenario, recording how it went either way so the report shows failures too. */
async function scenario(
    gym: RealGym | null,
    vendor: RealGymVendor,
    body: (gym: RealGym) => Promise<void>,
): Promise<void> {
    if (gym === null) {
        expect.fail(`RIG_LIVE_TEST=1 is set but this machine is not signed in to ${vendor}.`);
    }
    try {
        await body(gym);
        await gym.close("passed");
    } catch (error: unknown) {
        await gym.close("failed", error instanceof Error ? error.message : String(error));
        throw error;
    }
}

describe.skipIf(!live)("real inference", () => {
    it.each(VENDORS)(
        "answers a basic question through $vendor",
        { timeout: 300_000 },
        async ({ vendor, model }) => {
            const gym = await createRealGym(ctx, {
                scenario: `Basic inference through ${vendor}`,
                vendor,
                model,
                effort: "low",
                traces,
            });
            await scenario(gym, vendor, async (live) => {
                // A question with exactly one right answer, so a passing run means the whole
                // path worked rather than that the model was merely agreeable.
                const answer = await live.ask(
                    ctx,
                    "What is 17 plus 25? Reply with the number and nothing else.",
                );

                expect(answer).toContain("42");
                const [inference] = live.trace.inferences;
                expect(inference?.failure).toBeUndefined();
                expect(inference?.doneState).toBe("normal");
                // The provider measured the turn, so the agent knows how large it has become.
                expect(inference?.tokens?.input).toBeGreaterThan(0);
                expect(inference?.tokens?.output).toBeGreaterThan(0);

                // The features really assembled this session: the system feature's environment
                // section, the models feature's catalog, and the subagent and gym tools.
                const [session] = live.trace.sessions;
                expect(session?.instructions).toContain("# Environment");
                expect(session?.instructions).toContain(live.trace.environment.workingDirectory);
                expect(session?.instructions).toContain("# Available models");
                expect(session?.instructions).toContain(model);
                expect(session?.tools.map((tool) => tool.name)).toEqual([
                    "spawn_agent",
                    "record_answer",
                ]);

                // The answer survived into the durable conversation a restart would rebuild.
                expect(live.transcript.length).toBeGreaterThan(0);
            });
        },
    );

    it.each(VENDORS)(
        "executes a real tool call through $vendor",
        { timeout: 300_000 },
        async ({ vendor, model }) => {
            const gym = await createRealGym(ctx, {
                scenario: `Tool call through ${vendor}`,
                vendor,
                model,
                effort: "low",
                traces,
            });
            await scenario(gym, vendor, async (live) => {
                await live.ask(
                    ctx,
                    "Call record_answer with the capital of France as the answer, then stop.",
                );

                const calls = live.trace.inferences.flatMap((inference) => toolCallsOf(inference));
                expect(calls.map((call) => call.name)).toContain("record_answer");
                expect(calls.map((call) => call.args).join(" ")).toContain("Paris");
                // The result travelled back into the conversation, so the model answered again
                // on a context that already held it.
                expect(live.trace.inferences.length).toBeGreaterThan(1);
                expect(live.transcript.some((message) => message.role === "tool")).toBe(true);
            });
        },
    );
});
