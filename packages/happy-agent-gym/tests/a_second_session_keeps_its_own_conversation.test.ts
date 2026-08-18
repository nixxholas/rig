import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym, type GymInferenceRequest } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

function userTextsIn(request: GymInferenceRequest | undefined): readonly string[] {
    const texts: string[] = [];
    for (const message of request?.messages ?? []) {
        if (message.role !== "user") continue;
        for (const block of message.content) {
            if (block.type === "text") texts.push(block.text);
        }
    }
    return texts;
}

describe("a second session keeps its own conversation", () => {
    it("shows the model only what was said in its own session, never the other one's", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "Widgets noted.", type: "text" }] },
                { content: [{ text: "Gadgets noted.", type: "text" }] },
                { content: [{ text: "We were discussing widgets.", type: "text" }] },
                { content: [{ text: "We were discussing gadgets.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Let's talk about widgets.");
        const second = await gym.createSession({ cwd: gym.workspacePath });
        expect(second.id).not.toBe(gym.rootSessionId);

        await gym.send("Let's talk about gadgets.", { sessionId: second.id });

        // Both sessions are asked a follow-up. Each request's own message history is what proves
        // the histories never mixed, not the model's reply.
        await gym.send("What have we been discussing?");
        await gym.send("What have we been discussing?", { sessionId: second.id });

        const rootFollowUp = userTextsIn(gym.inference.requests[2]);
        expect(rootFollowUp).toContain("Let's talk about widgets.");
        expect(rootFollowUp).not.toContain("Let's talk about gadgets.");

        const secondFollowUp = userTextsIn(gym.inference.requests[3]);
        expect(secondFollowUp).toContain("Let's talk about gadgets.");
        expect(secondFollowUp).not.toContain("Let's talk about widgets.");

        // The client-facing projection is scoped the same way the model's context was.
        const rootEvents = JSON.stringify(await gym.sessionEvents());
        expect(rootEvents).toContain("We were discussing widgets.");
        expect(rootEvents).not.toContain("We were discussing gadgets.");

        const secondEvents = JSON.stringify(await gym.sessionEvents(second.id));
        expect(secondEvents).toContain("We were discussing gadgets.");
        expect(secondEvents).not.toContain("We were discussing widgets.");

        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("lists the new session alongside the root chat", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Started.", type: "text" }] }],
        });
        running.add(gym);

        const second = await gym.createSession({ cwd: gym.workspacePath });
        const sessions = await gym.listSessions();

        expect(sessions.map((session) => session.id)).toEqual(
            expect.arrayContaining([gym.rootSessionId, second.id]),
        );
    });

    it("answers a session that was never created with a 404 naming the id", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const response = await gym.http.get("/v0/sessions/does-not-exist");

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({
            error: 'Session "does-not-exist" was not found.',
        });
    });
});
