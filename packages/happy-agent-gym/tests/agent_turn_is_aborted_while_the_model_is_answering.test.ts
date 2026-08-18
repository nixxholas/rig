import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();
/**
 * Every gate a scenario opened the model with. They are released before the gyms are disposed,
 * because a daemon closing while the scripted model is still held inside a turn would wait for a
 * stream nobody is ever going to finish.
 */
const gates = new Set<() => void>();

afterEach(async () => {
    for (const release of gates) release();
    gates.clear();
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * A point the scripted model can be held at until the scenario lets it go. Holding the model is
 * what makes an interruption deterministic: the turn is provably still in flight when the abort
 * arrives, rather than probably still in flight because a delay was long enough.
 */
function createGate(): { readonly held: Promise<void>; readonly release: () => void } {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
        release = (): void => {
            resolve();
        };
    });
    gates.add(release);
    return { held, release };
}

describe("a turn is aborted while the model is still answering", () => {
    it("settles the run as aborted and never carries out what the model had not finished saying", async () => {
        const gate = createGate();
        const gym = await createAgentGym({
            files: { "README.md": "fixture repository\n" },
            inference: async (request) => {
                if (request.callIndex === 0) {
                    // The model is held here, in the middle of the turn, until the run has been
                    // aborted. The tool call below is what the turn would have done next.
                    await gate.held;
                    return {
                        content: [
                            {
                                arguments: { cmd: "echo too late > after_the_abort.md" },
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return {
                    content: [{ text: "Stopped, and here is the short answer.", type: "text" }],
                };
            },
            permissionMode: "full_access",
        });
        running.add(gym);

        const started = await gym.send("Take an inventory of the repository.", { wait: false });
        await gym.waitUntil(
            () => (gym.inference.requests.length === 1 ? true : undefined),
            "the model to be asked for the first time",
        );

        await gym.abort();
        gate.release();

        const settled = await gym.waitForRun(started.runId);
        expect(settled.payload).toMatchObject({ stopReason: "aborted" });

        // What a client renders: this run ended, and it says it was interrupted rather than
        // finished.
        const finished = (await gym.sessionEvents()).find(
            (event) =>
                event.type === "run_finished" &&
                (event.data as { readonly runId?: string }).runId === started.runId,
        );
        expect(finished?.data).toMatchObject({ runId: started.runId, stopReason: "aborted" });

        // The abort really cut the turn short. The command the held answer was about to make
        // never reached the machine, so the file it would have written is not there, no tool
        // result was ever shown to the model, and the model was never asked a second time.
        expect(await gym.exists("after_the_abort.md")).toBe(false);
        expect(await gym.listFiles()).not.toContain("after_the_abort.md");
        expect(gym.inference.toolResults()).toEqual([]);
        expect(gym.inference.requests).toHaveLength(1);
        // The chat's own status is deliberately not asserted here: the settlement overwrites the
        // abort route's "aborted" with "completed", which is reported as a defect with these
        // tests. The run's stop reason above is the truthful record of the interruption.

        // The chat is not poisoned by the interruption: the next message is answered normally.
        await gym.send("Never mind, just answer briefly.");
        expect(JSON.stringify(await gym.sessionEvents())).toContain(
            "Stopped, and here is the short answer.",
        );
        expect(gym.inference.userTexts()).toContain("Never mind, just answer briefly.");
        expect(gym.errors).toEqual([]);
    });
});

describe("an abort arrives with nothing to interrupt", () => {
    it("records the request against an idle chat without starting or ending a run", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Still here.", type: "text" }] }],
        });
        running.add(gym);

        const before = (await gym.events()).map((event) => event.type);

        const aborted = await gym.http.post<{
            readonly eventId: string;
            readonly session: { readonly status: string };
        }>(`/v0/sessions/${gym.defaultSessionId}/abort`, { await: true });
        expect(aborted.status).toBe(200);
        expect(aborted.body.session.status).toBe("aborted");
        expect(aborted.body.eventId.length).toBeGreaterThan(0);

        // The abort ran nothing: the model was never asked, and the journal is exactly what it was
        // before, so no run was opened, cancelled or settled on the way through.
        expect(gym.inference.requests).toEqual([]);
        expect((await gym.events()).map((event) => event.type)).toEqual(before);

        // A chat aborted while idle still answers, and stops reporting itself as aborted.
        await gym.send("Are you still there?");
        expect(JSON.stringify(await gym.sessionEvents())).toContain("Still here.");
        await gym.waitUntil(
            async () => ((await gym.getSession()).status === "completed" ? true : undefined),
            "the chat to report itself finished rather than aborted",
        );
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("answers that a chat it has never heard of is not there", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const response = await gym.http.post<{ readonly error: string }>(
            "/v0/sessions/never-opened/abort",
            { await: true },
        );

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Session "never-opened" was not found.');
        // A deliberate 404 is not an unexpected server failure.
        expect(gym.errors).toEqual([]);
    });
});
