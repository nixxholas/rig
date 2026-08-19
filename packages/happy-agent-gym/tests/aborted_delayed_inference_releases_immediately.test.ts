import { afterEach, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/createAgentGym.js";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

it("releases delayed scripted inference immediately when the run is aborted", async () => {
    const gym = await createAgentGym({
        inference: [
            {
                content: [{ text: "too late", type: "text" }],
                delayMs: 60_000,
            },
        ],
    });
    activeGyms.add(gym);

    const accepted = await gym.send("keep working", { wait: false });
    await gym.client.abortAgent(gym.defaultSessionId, {
        expectedRunId: accepted.runId,
    });

    const finished = await gym.waitForRun(accepted.runId);
    expect(finished).toMatchObject({
        type: "run.finished",
        payload: {
            run: {
                id: accepted.runId,
                reason: "abort",
                status: "aborted",
            },
        },
    });

    await gym.dispose();
    activeGyms.delete(gym);
}, 5_000);
