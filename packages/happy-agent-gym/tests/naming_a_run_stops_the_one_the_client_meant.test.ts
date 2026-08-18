import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();
const release = new Set<() => void>();

afterEach(async () => {
    for (const open of release) open();
    release.clear();
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

function gate(): { readonly held: Promise<void>; open(): void } {
    let open = (): void => {};
    const held = new Promise<void>((resolve) => {
        open = () => resolve();
    });
    release.add(open);
    return { held, open };
}

describe("a client that says which run it means", () => {
    it("stops that run when it is still the one going", async () => {
        const reached = gate();
        const held = gate();
        const gym = await createAgentGym({
            inference: async () => {
                reached.open();
                await held.held;
                return { content: [{ text: "Never delivered.", type: "text" }] };
            },
        });
        running.add(gym);

        const acceptance = await gym.send("Take your time.", { wait: false });
        await reached.held;

        const response = await gym.http.post(`/v0/sessions/${gym.defaultSessionId}/abort`, {
            expectedRunId: acceptance.runId,
        });
        expect(response.status).toBe(200);

        held.open();
        await gym.waitForRun(acceptance.runId);
        expect((await gym.getSession()).status).toBe("aborted");
    });

    it("refuses to stop a different run from the one it was looking at", async () => {
        const reached = gate();
        const held = gate();
        const gym = await createAgentGym({
            inference: async () => {
                reached.open();
                await held.held;
                return { content: [{ text: "Delivered after all.", type: "text" }] };
            },
        });
        running.add(gym);

        const acceptance = await gym.send("Take your time.", { wait: false });
        await reached.held;

        // The run this client remembers finished long ago; the chat has moved on to another one.
        const response = await gym.http.post(`/v0/sessions/${gym.defaultSessionId}/abort`, {
            expectedRunId: "a-run-that-finished",
        });
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
            error: `Run "a-run-that-finished" is no longer running; this chat is now on run "${acceptance.runId}", which was not aborted.`,
        });

        // The refusal is a refusal: the run it named is untouched and still finishes normally.
        held.open();
        const settled = await gym.waitForRun(acceptance.runId);
        expect(settled.payload).toMatchObject({ stopReason: "stop" });
        expect(gym.errors).toEqual([]);
    });

    it("still acts when the client names nothing at all", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Answered.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("Anything.");
        const response = await gym.http.post(`/v0/sessions/${gym.defaultSessionId}/abort`, {});
        expect(response.status).toBe(200);
    });
});
