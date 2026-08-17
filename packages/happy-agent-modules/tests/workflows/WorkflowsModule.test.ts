import { describe, expect, it } from "vitest";

import {
    agentOptions,
    agentRequest,
    workflowWorld,
    WORKFLOW_MODEL,
    WORKFLOW_OWNER,
} from "./support/workflowWorld.js";

/** Monty loads and runs a real interpreter, so a run is slower than an ordinary unit test. */
const RUN_TIMEOUT = 30_000;

describe("workflow execution", () => {
    it(
        "completes a script that starts no agents and keeps what it returned",
        async () => {
            const world = await workflowWorld("workflows-plain-script");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    {
                        script: '"Report on " + args["topic"]',
                        args: { topic: "birds" },
                        name: "report",
                    },
                    "run-plain",
                );
                await world.module.whenRunsSettle();

                const run = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-plain");
                expect(run?.status).toBe("completed");
                expect(run).toMatchObject({
                    workflow: "report",
                    description: "Run report",
                    agentCount: 0,
                    output: "Report on birds",
                });
                expect(world.collaborators.started).toHaveLength(0);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "starts one collaborator the workflow reads itself and hands the script its answer",
        async () => {
            const world = await workflowWorld("workflows-single-agent");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: `agent("Review the parser.", ${agentOptions("Review")})` },
                    "run-one",
                );
                const [collaborator] = await world.collaborators.waitFor(1);
                await world.answer(collaborator!, "The parser is fine.");
                await world.module.whenRunsSettle();

                expect(collaborator).toMatchObject({
                    actingAgentId: WORKFLOW_OWNER,
                    input: {
                        title: "Review",
                        model: WORKFLOW_MODEL,
                        effort: "medium",
                        text: "Review the parser.",
                    },
                    options: {
                        // The workflow collects the answer itself, so nothing is reported into
                        // the calling agent's conversation.
                        reportToCreator: false,
                        metadata: { workflow: { runId: "run-one", callIndex: 0 } },
                    },
                });
                const run = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-one");
                expect(run?.status).toBe("completed");
                expect(run).toMatchObject({ agentCount: 1, output: "The parser is fine." });
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "ignores an agent that is not one of its own",
        async () => {
            const world = await workflowWorld("workflows-foreign-agent");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: `agent("Review the parser.", ${agentOptions("Review")})` },
                    "run-foreign",
                );
                const [collaborator] = await world.collaborators.waitFor(1);

                // An ordinary collaborator settling says nothing about a workflow, whatever it
                // last said, so the run is still waiting for the agent it actually started.
                await world.answer(
                    { ...collaborator!, agentId: "stranger", options: {} },
                    "Nothing to do with the workflow.",
                );
                expect(
                    (await world.module.status(world.ctx, WORKFLOW_OWNER, "run-foreign"))?.status,
                ).toBe("running");

                await world.answer(collaborator!, "The parser is fine.");
                await world.module.whenRunsSettle();
                expect(
                    await world.module.status(world.ctx, WORKFLOW_OWNER, "run-foreign"),
                ).toMatchObject({ status: "completed", output: "The parser is fine." });
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "keeps parallel results in input order however the agents finish",
        async () => {
            const world = await workflowWorld("workflows-parallel");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    {
                        script: [
                            "parallel([",
                            `    ${agentRequest("one", "Check one.")},`,
                            `    ${agentRequest("two", "Check two.")},`,
                            `    ${agentRequest("three", "Check three.")},`,
                            "])",
                        ].join("\n"),
                    },
                    "run-parallel",
                );
                const started = await world.collaborators.waitFor(3);
                expect(started.map((collaborator) => collaborator.input.title)).toEqual([
                    "one",
                    "two",
                    "three",
                ]);

                await world.answer(started[2]!, "Third answer.");
                await world.answer(started[0]!, "First answer.");
                await world.answer(started[1]!, "Second answer.");
                await world.module.whenRunsSettle();

                const run = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-parallel");
                expect(run?.status).toBe("completed");
                expect(run?.agentCount).toBe(3);
                expect(JSON.parse(run?.status === "completed" ? run.output : "")).toEqual([
                    "First answer.",
                    "Second answer.",
                    "Third answer.",
                ]);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "carries every item through a pipeline stage and keeps the results in item order",
        async () => {
            const world = await workflowWorld("workflows-pipeline");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    {
                        script: [
                            'pipeline(["alpha", "beta"], [',
                            `    ${agentRequest("improve", "Improve it.")},`,
                            "])",
                        ].join("\n"),
                    },
                    "run-pipeline",
                );
                const started = await world.collaborators.waitFor(2);
                const forItem = (item: string) => {
                    const found = started.find((collaborator) =>
                        collaborator.input.text.includes(`\n${item}\n`),
                    );
                    if (found === undefined) throw new Error(`Expected the agent for ${item}.`);
                    return found;
                };
                expect(forItem("alpha").input.text).toContain("Original item (1/2):");
                expect(forItem("beta").input.text).toContain("Original item (2/2):");

                await world.answer(forItem("beta"), "Beta improved.");
                await world.answer(forItem("alpha"), "Alpha improved.");
                await world.module.whenRunsSettle();

                const run = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-pipeline");
                expect(run?.status).toBe("completed");
                expect(JSON.parse(run?.status === "completed" ? run.output : "")).toEqual([
                    "Alpha improved.",
                    "Beta improved.",
                ]);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "refuses to start a second run under an identity it already used",
        async () => {
            const world = await workflowWorld("workflows-duplicate-id");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: '"once"' },
                    "run-twice",
                );
                await world.module.whenRunsSettle();

                await expect(
                    world.module.launch(
                        world.ctx,
                        WORKFLOW_OWNER,
                        { script: '"again"' },
                        "run-twice",
                    ),
                ).rejects.toThrow('Workflow run "run-twice" already exists.');
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "fails a run when the agent it is waiting for stops without answering",
        async () => {
            const world = await workflowWorld("workflows-agent-failure");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: `agent("Review the parser.", ${agentOptions("Review")})` },
                    "run-agent-failure",
                );
                const [collaborator] = await world.collaborators.waitFor(1);
                await world.fail(collaborator!, "The provider refused the request.");
                await world.module.whenRunsSettle();

                const run = await world.module.status(
                    world.ctx,
                    WORKFLOW_OWNER,
                    "run-agent-failure",
                );
                expect(run?.status).toBe("failed");
                expect(run).toMatchObject({ error: "The provider refused the request." });
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "fails a run whose script cannot run, and says what went wrong",
        async () => {
            const world = await workflowWorld("workflows-script-failure");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: 'agent("Review.", {"model": "", "effort": "medium"})' },
                    "run-script-failure",
                );
                await world.module.whenRunsSettle();

                const run = await world.module.status(
                    world.ctx,
                    WORKFLOW_OWNER,
                    "run-script-failure",
                );
                expect(run?.status).toBe("failed");
                expect(run?.status === "failed" ? run.error : "").toContain(
                    "Agent options must be a dictionary",
                );
                expect(world.collaborators.started).toHaveLength(0);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "cancels a run that is waiting on an agent, and leaves a finished run alone",
        async () => {
            const world = await workflowWorld("workflows-cancel");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: `agent("Review the parser.", ${agentOptions("Review")})` },
                    "run-cancel",
                );
                await world.collaborators.waitFor(1);

                const cancelled = await world.module.cancel(
                    world.ctx,
                    WORKFLOW_OWNER,
                    "run-cancel",
                );
                expect(cancelled.status).toBe("cancelled");
                // The agent it was waiting on is a separate session that would keep spending, so
                // stopping the script has to stop it too.
                expect(world.collaborators.interrupted).toEqual([
                    world.collaborators.started[0]?.agentId,
                ]);
                await world.module.whenRunsSettle();

                const stored = await world.module.status(world.ctx, WORKFLOW_OWNER, "run-cancel");
                expect(stored).toEqual(cancelled);

                const again = await world.module.cancel(world.ctx, WORKFLOW_OWNER, "run-cancel");
                expect(again).toEqual(cancelled);
                // A run that was already cancelled has nobody left to stop.
                expect(world.collaborators.interrupted).toHaveLength(1);
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "returns the settled run to whoever waited for it",
        async () => {
            const world = await workflowWorld("workflows-wait");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: `agent("Review the parser.", ${agentOptions("Review")})` },
                    "run-wait",
                );
                const waiting = world.module.wait(world.ctx, WORKFLOW_OWNER, "run-wait");
                const [collaborator] = await world.collaborators.waitFor(1);
                await world.answer(collaborator!, "Waited for this.");

                const run = await waiting;
                expect(run.status).toBe("completed");
                expect(run).toMatchObject({ output: "Waited for this." });
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "pauses only the runs no process is executing any more",
        async () => {
            const world = await workflowWorld("workflows-abandoned");
            try {
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script: `agent("Review the parser.", ${agentOptions("Review")})` },
                    "run-abandoned",
                );
                await world.collaborators.waitFor(1);

                // This process is still executing the run, so its own start leaves it alone.
                await world.hooks.afterStart?.(world.ctx, undefined as never);
                expect(
                    (await world.module.status(world.ctx, WORKFLOW_OWNER, "run-abandoned"))?.status,
                ).toBe("running");

                const restarted = await world.restart();
                await restarted.hooks.afterStart?.(restarted.ctx, undefined as never);

                const paused = await restarted.module.status(
                    restarted.ctx,
                    WORKFLOW_OWNER,
                    "run-abandoned",
                );
                expect(paused?.status).toBe("paused");
                expect(paused).toMatchObject({ agentCount: 1, workflow: "dynamic-workflow" });
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );

    it(
        "pauses a run its process left behind, then resumes it without paying for answered agents again",
        async () => {
            const world = await workflowWorld("workflows-resume");
            try {
                const script = [
                    "answers = parallel([",
                    `    ${agentRequest("one", "Check one.")},`,
                    `    ${agentRequest("two", "Check two.")},`,
                    "])",
                    `summary = agent("Summarize: " + answers[0] + " " + answers[1], ${agentOptions("summary")})`,
                    '{"answers": answers, "summary": summary}',
                ].join("\n");
                await world.module.launch(
                    world.ctx,
                    WORKFLOW_OWNER,
                    { script, name: "review" },
                    "run-resume",
                );
                const started = await world.collaborators.waitFor(2);
                await world.answer(started[0]!, "First answer.");

                // The process stops here: the second agent is still working, so its run is left
                // marked running with one answered call and a checkpoint behind it.
                const restarted = await world.restart();
                await restarted.hooks.afterStart?.(restarted.ctx, undefined as never);

                const paused = await restarted.module.status(
                    restarted.ctx,
                    WORKFLOW_OWNER,
                    "run-resume",
                );
                expect(paused?.status).toBe("paused");
                expect(paused?.status === "paused" ? paused.pausedAt : undefined).toBe(
                    paused?.updatedAt,
                );

                const resumed = await restarted.module.resume(
                    restarted.ctx,
                    WORKFLOW_OWNER,
                    "run-resume",
                );
                expect(resumed.status).toBe("running");

                const second = await restarted.collaborators.byTitle("two");
                await restarted.answer(second, "Second answer.");
                const summary = await restarted.collaborators.byTitle("summary");
                await restarted.answer(summary, "Both checks passed.");
                await restarted.module.whenRunsSettle();

                // The agent that already answered is not started again; only the call that was
                // still outstanding and the one after it are.
                expect(
                    restarted.collaborators.started.map((collaborator) => collaborator.input.title),
                ).toEqual(["two", "summary"]);
                expect(summary.input.text).toContain("First answer. Second answer.");

                const run = await restarted.module.status(
                    restarted.ctx,
                    WORKFLOW_OWNER,
                    "run-resume",
                );
                expect(run?.status).toBe("completed");
                expect(JSON.parse(run?.status === "completed" ? run.output : "")).toEqual({
                    answers: ["First answer.", "Second answer."],
                    summary: "Both checks passed.",
                });
                expect(run?.logs).toContain("Reused one from the previous run.");
            } finally {
                world.close();
            }
        },
        RUN_TIMEOUT,
    );
});
