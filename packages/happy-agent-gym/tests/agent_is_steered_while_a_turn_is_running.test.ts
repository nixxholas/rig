import { afterEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "@slopus/happy-agent-modules";

import {
    createAgentGym,
    runIdOf,
    type AgentGym,
    type GymInferenceRequest,
} from "../sources/index.js";

const running = new Set<AgentGym>();
/**
 * Every gate a scenario held the model with. They are released before the gyms are disposed,
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
 * what makes steering land mid-turn deterministically, rather than depending on a delay being
 * long enough on whichever machine runs the test.
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

/** The user text of one recorded inference request, in the order the model was shown it. */
function userTextsOf(request: GymInferenceRequest | undefined): readonly string[] {
    const texts: string[] = [];
    for (const message of request?.messages ?? []) {
        if (message.role !== "user") continue;
        for (const block of message.content) {
            if (block.type === "text") texts.push(block.text);
        }
    }
    return texts;
}

/** How a message was delivered, as the durable acceptance recorded it. */
function deliveryKindOf(event: AgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const kind = (payload as { readonly kind?: unknown }).kind;
    return typeof kind === "string" ? kind : undefined;
}

describe("the agent is steered while a turn is running", () => {
    it("shows the model the steering in the run it was already answering", async () => {
        const gate = createGate();
        const gym = await createAgentGym({
            files: { "README.md": "fixture repository\n", "LICENCE.md": "public domain\n" },
            inference: async (request) => {
                if (request.callIndex === 0) {
                    // Held mid-turn until the steering has been accepted, so the message can only
                    // reach the model at the boundary after this response and its tool call.
                    await gate.held;
                    return {
                        content: [
                            {
                                arguments: { cmd: "ls" },
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return {
                    content: [{ text: "The repository has a readme and a licence.", type: "text" }],
                };
            },
            permissionMode: "full_access",
        });
        running.add(gym);

        const started = await gym.send("List what is in the repository.", { wait: false });
        await gym.waitUntil(
            () => (gym.inference.requests.length === 1 ? true : undefined),
            "the model to be asked for the first time",
        );

        const steered = await gym.steer("Also mention the licence file.");
        gate.release();

        const settled = await gym.waitForRun(started.runId);
        expect(settled.payload).toMatchObject({ stopReason: "stop" });

        // The steered words really reached the model, in the request that followed the tool call.
        const second = gym.inference.requests[1];
        expect(userTextsOf(second)).toEqual([
            "List what is in the repository.",
            "Also mention the licence file.",
        ]);
        expect(gym.inference.requests).toHaveLength(2);

        // The turn carried on rather than restarting: the same run answered both messages, the
        // tool call made before the steering arrived is still in the conversation the model was
        // shown, and its output is still there too.
        const accepted = await gym.waitForEvent(
            (event) => event.type === "message.accepted" && deliveryKindOf(event) === "steering",
            "the steering message to be accepted",
        );
        expect(runIdOf(accepted)).toBe(started.runId);
        const ofThisRun = (await gym.events()).filter((event) => runIdOf(event) === started.runId);
        expect(ofThisRun.filter((event) => event.type === "message.accepted")).toHaveLength(2);
        expect(ofThisRun.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(ofThisRun.filter((event) => event.type === "loop.settled")).toHaveLength(1);
        expect(second?.messages.some((message) => message.role === "tool")).toBe(true);
        expect(gym.inference.toolResults()[0]?.text).toContain("LICENCE.md");

        // What a client sees: the steering was submitted into the same run, marked as steering
        // rather than as a message of its own.
        const submitted = (await gym.sessionEvents()).filter(
            (event) => event.type === "message_submitted",
        );
        expect(submitted.map((event) => event.data)).toEqual([
            expect.objectContaining({
                delivery: "run",
                displayText: "List what is in the repository.",
            }),
            expect.objectContaining({
                delivery: "steer",
                displayText: "Also mention the licence file.",
                runId: started.runId,
            }),
        ]);
        expect(steered.sessionId).toBe(gym.defaultSessionId);
        expect(gym.errors).toEqual([]);
    });
});

describe("the agent is steered when it is not working", () => {
    it("answers the steering as a run of its own", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "Nothing was under way, so here I am.", type: "text" }] },
            ],
        });
        running.add(gym);

        const accepted = await gym.steer("Start with the readme.");
        expect(accepted).toMatchObject({ accepted: "created", delivery: "steer" });

        // With no turn to join, the steering opens a run named after the message itself.
        const settled = await gym.waitForRun(accepted.runId);
        expect(settled.payload).toMatchObject({ stopReason: "stop" });
        expect(gym.inference.userTexts()).toEqual(["Start with the readme."]);
        expect(JSON.stringify(await gym.sessionEvents())).toContain(
            "Nothing was under way, so here I am.",
        );
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
