import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, runIdOf, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();
const release = new Set<() => void>();

afterEach(async () => {
    // A daemon cannot close while a scripted turn is still being held, so let every held turn go
    // before disposing.
    for (const open of release) open();
    release.clear();
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A promise a scenario resolves when it wants the model to carry on. */
function gate(): { readonly held: Promise<void>; open(): void } {
    let open = (): void => {};
    const held = new Promise<void>((resolve) => {
        open = () => resolve();
    });
    release.add(open);
    return { held, open };
}

describe("a session that was interrupted", () => {
    it("still says it was aborted once the run it interrupted has settled", async () => {
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
        await gym.abort();
        held.open();
        await gym.waitForRun(acceptance.runId);

        // Settling is what used to overwrite this: a run that was cut short is not a run that
        // finished, and re-reading the session has to keep saying so.
        expect((await gym.getSession()).status).toBe("aborted");
    });

    it("goes back to running when the next message starts a new run", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "First.", type: "text" }] },
                { content: [{ text: "Second.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.abort();
        expect((await gym.getSession()).status).toBe("aborted");

        await gym.send("Carry on.");
        expect((await gym.getSession()).status).toBe("completed");
    });
});

describe("listing the chats a person has", () => {
    it("leaves out the ones they archived, and offers a way to ask for everything", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Noted.", type: "text" }] }],
        });
        running.add(gym);

        const second = await gym.createSession();
        await gym.http.ok("POST", `/v0/sessions/${second.id}/archive`, {});

        const listed = await gym.listSessions();
        expect(listed.map((session) => session.id)).not.toContain(second.id);
        expect(listed.map((session) => session.id)).toContain(gym.rootSessionId);

        const everything = await gym.http.ok<{ readonly sessions: readonly { id: string }[] }>(
            "GET",
            "/v0/sessions?archived=all",
        );
        expect(everything.sessions.map((session) => session.id)).toContain(second.id);
    });
});

describe("compacting a conversation", () => {
    it("leaves a note in the chat saying the earlier messages are gone", async () => {
        // The gym's own compaction answer is enough here: what matters is that the chat says a
        // compaction happened, not what the replacement conversation turned out to be.
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "An answer.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("Remember this.");
        await gym.compact();

        const notice = (await gym.sessionEvents()).find(
            (event) => event.type === "system_notice",
        ) as
            | { readonly data?: { readonly message?: { readonly structured?: unknown } } }
            | undefined;
        expect(JSON.stringify(notice)).toContain("summarised");
    });
});

describe("what a turn cost", () => {
    it("reports how big the conversation now is, not just what it has spent", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [{ text: "An answer.", type: "text" }],
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 900,
                        output: 100,
                        totalTokens: 1_000,
                    },
                },
            ],
        });
        running.add(gym);

        const acceptance = await gym.send("How big is this?");
        expect(runIdOf(await gym.waitForRun(acceptance.runId))).toBe(acceptance.runId);

        const usage = await gym.http.ok<{
            readonly sessionTokenCount: {
                readonly lastContextTokens: number;
                readonly totalTokens: number;
            };
        }>("GET", `/v0/sessions/${gym.rootSessionId}/usage`);
        expect(usage.sessionTokenCount.totalTokens).toBe(1000);
        expect(usage.sessionTokenCount.lastContextTokens).toBe(1000);
    });
});
