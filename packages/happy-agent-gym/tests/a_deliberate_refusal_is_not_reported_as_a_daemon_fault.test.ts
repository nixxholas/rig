import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("a deliberate refusal is not reported as a daemon fault", () => {
    it("renders an unrecognised route's 404 without touching the unexpected-error hook", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const response = await gym.http.get<{ readonly error: string }>("/v0/does-not-exist");

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Route not found." });
        expect(gym.errors).toEqual([]);
    });

    it("renders an unknown session's 404 the same way", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const response = await gym.http.post<{ readonly error: string }>(
            "/v0/sessions/never-opened/abort",
            {},
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Session "never-opened" was not found.' });
        expect(gym.errors).toEqual([]);
    });
});
