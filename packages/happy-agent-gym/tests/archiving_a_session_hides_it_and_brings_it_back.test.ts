import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("archiving a session hides it and brings it back", () => {
    it("removes an archived session from the active listing, then restores it with its history intact", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "First reply.", type: "text" }] },
                { content: [{ text: "Second reply.", type: "text" }] },
            ],
        });
        running.add(gym);

        const session = await gym.createSession({ cwd: gym.workspacePath });
        await gym.send("First message.", { sessionId: session.id });
        await gym.send("Second message.", { sessionId: session.id });

        const archived = await gym.http.ok<{ readonly session: Record<string, unknown> }>(
            "POST",
            `/v0/sessions/${session.id}/archive`,
        );
        expect(archived.session).toMatchObject({ archived: true, status: "archived" });

        // A client asking for its active sessions excludes it.
        const active = await gym.http.ok<{ readonly sessions: readonly { id: string }[] }>(
            "GET",
            "/v0/sessions?archived=false",
        );
        expect(active.sessions.map((entry) => entry.id)).not.toContain(session.id);

        // Asking for archived sessions specifically finds it there instead.
        const archivedList = await gym.http.ok<{ readonly sessions: readonly { id: string }[] }>(
            "GET",
            "/v0/sessions?archived=true",
        );
        expect(archivedList.sessions.map((entry) => entry.id)).toContain(session.id);

        const unarchived = await gym.http.ok<{ readonly session: Record<string, unknown> }>(
            "POST",
            `/v0/sessions/${session.id}/unarchive`,
        );
        expect(unarchived.session).toMatchObject({ archived: false, status: "idle" });

        const restoredActive = await gym.http.ok<{
            readonly sessions: readonly { id: string }[];
        }>("GET", "/v0/sessions?archived=false");
        expect(restoredActive.sessions.map((entry) => entry.id)).toContain(session.id);

        // The conversation itself was never touched by the archive round trip.
        const restored = await gym.getSession(session.id);
        const snapshot = JSON.stringify(restored);
        expect(snapshot).toContain("First message.");
        expect(snapshot).toContain("Second message.");
        expect(snapshot).toContain("First reply.");
        expect(snapshot).toContain("Second reply.");

        expect(gym.errors).toEqual([]);
    });

    // The gym's own `listSessions()` calls the bare `GET /v0/sessions`, with no `archived` query
    // parameter at all. A bare listing means the chats a person has not put away, exactly like an
    // explicit `archived=false`; `archived=all` is what asks for everything, archived or not.
    it("excludes archived sessions from the bare listing, and includes them when asked for all", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const session = await gym.createSession({ cwd: gym.workspacePath });
        await gym.http.ok("POST", `/v0/sessions/${session.id}/archive`);

        const bare = await gym.listSessions();
        expect(bare.map((entry) => entry.id)).not.toContain(session.id);

        const all = await gym.http.ok<{ readonly sessions: readonly { id: string }[] }>(
            "GET",
            "/v0/sessions?archived=all",
        );
        expect(all.sessions.map((entry) => entry.id)).toContain(session.id);
    });

    // Forking, resetting, and rewinding a session's history are not implemented: every one of
    // these routes throws unconditionally in sessionRoutes.ts:967-982, before touching any
    // conversation state. This documents today's behavior; see the final report for the finding.
    it("refuses to fork, reset, or rewind a session because none of those operations are configured", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "First reply.", type: "text" }] },
                { content: [{ text: "Second reply.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("First message.");
        await gym.send("Second message.");

        for (const operation of ["fork", "reset", "rewind"]) {
            const response = await gym.http.post(`/v0/sessions/${gym.defaultSessionId}/${operation}`);
            expect(response.status).toBe(503);
            expect(response.body).toMatchObject({
                error: "This session operation is not configured.",
            });
        }
    });
});
