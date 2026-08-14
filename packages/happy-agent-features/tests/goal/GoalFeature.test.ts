import { Agent, AgentSystemLocal } from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { GoalFeature } from "../../sources/index.js";
import { ScriptedProvider, type ScriptedSession } from "../support/ScriptedProvider.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../support/fixtures.js";
import { agentWorld } from "../support/agentWorld.js";

const ctx = createRootContext().named("happy-agent-features-goal");

/** Every text the model was sent, across every inference of a run. */
function requestedTexts(session: ScriptedSession): string[] {
    return session.requests.flatMap((request) =>
        request.context.messages.flatMap((message) =>
            message.role === "user"
                ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                : [],
        ),
    );
}

/** One agent of a collection, running that collection's goal feature. */
async function goalAgent(agentId: string, script: SessionEvent[][]) {
    const world = agentWorld();
    const provider = new ScriptedProvider(script);
    const goals = new GoalFeature({ storage: world.storage });
    const agent = await Agent.create(ctx, {
        id: agentId,
        providers: providersOf(provider),
        provider: "scripted",
        persistence: world.storage.persistence(agentId),
        sharedKV: sharedKV(),
        features: [goals],
    });
    return { agent, goals, provider };
}

describe("GoalFeature", () => {
    it("keeps the agent working while the goal is active, and lets it stop once it is complete", async () => {
        const { agent, goals, provider } = await goalAgent("goal-agent", [
            toolCallTurn("call-1", "create_goal", JSON.stringify({ objective: "ship the thing" })),
            textTurn("goal started"),
            toolCallTurn("call-2", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("all done"),
        ]);

        await agent.send(ctx, user("start a goal"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The agent never opened a session.");
        // Four inferences: the tool call and its follow-up in the first turn, then the same
        // again in the turn the feature itself asked for.
        expect(session.requests).toHaveLength(4);
        expect(requestedTexts(session).join("\n")).toContain(
            "Continue working toward the active goal.",
        );
        // What the model's tools wrote is what an outside caller reads: one store, one goal.
        expect(await goals.goal(ctx, "goal-agent")).toEqual({
            createdAt: expect.any(Number),
            objective: "ship the thing",
            status: "complete",
            updatedAt: expect.any(Number),
        });
    });

    it("lets an agent with no goal settle after one turn", async () => {
        const { agent, goals, provider } = await goalAgent("goalless-agent", [
            textTurn("answered"),
        ]);

        await agent.send(ctx, user("just answer"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(await goals.goal(ctx, "goalless-agent")).toBeUndefined();
    });

    it("stops asking for another turn once the model reports the goal blocked", async () => {
        const { agent, goals, provider } = await goalAgent("blocked-agent", [
            toolCallTurn("call-1", "create_goal", JSON.stringify({ objective: "ship the thing" })),
            textTurn("goal started"),
            toolCallTurn("call-2", "update_goal", JSON.stringify({ status: "blocked" })),
            textTurn("I need the credentials"),
        ]);

        await agent.send(ctx, user("start a goal"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.requests).toHaveLength(4);
        expect((await goals.goal(ctx, "blocked-agent"))?.status).toBe("blocked");
    });

    it("works toward a goal set from outside before the agent ever ran", async () => {
        const { agent, goals, provider } = await goalAgent("api-goal-agent", [
            textTurn("answered the question"),
            toolCallTurn("call-1", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("done"),
        ]);

        await goals.setGoal(ctx, "api-goal-agent", "ship the thing");
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The agent never opened a session.");
        expect(requestedTexts(session).join("\n")).toContain("ship the thing");
        expect((await goals.goal(ctx, "api-goal-agent"))?.status).toBe("complete");
    });

    it("does not continue a goal an outside caller paused", async () => {
        const { agent, goals, provider } = await goalAgent("paused-agent", [textTurn("answered")]);
        await goals.setGoal(ctx, "paused-agent", "ship the thing");
        await goals.changeGoalStatus(ctx, "paused-agent", "paused");

        await agent.send(ctx, user("anything else?"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        // A paused goal asks for nothing, so the agent answers once and settles.
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect((await goals.goal(ctx, "paused-agent"))?.status).toBe("paused");
    });

    it("sets a goal from outside to work by sending the agent into a turn", async () => {
        const world = agentWorld();
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "update_goal", JSON.stringify({ status: "complete" })),
            textTurn("done"),
        ]);
        const goals = new GoalFeature({ storage: world.storage });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            features: [goals],
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});

        // Nothing has been said to this agent, and nobody is driving it.
        await goals.setGoal(ctx, agent.id, "ship the thing");
        await agent.waitForIdle();
        await agent.close();

        const session = provider.sessions[0];
        if (session === undefined) throw new Error("The goal never started the agent.");
        expect(requestedTexts(session).join("\n")).toContain("ship the thing");
        expect((await goals.goal(ctx, agent.id))?.status).toBe("complete");
    });

    it("stops driving the agent after a failed turn, and gives up after three", async () => {
        const failedTurn: SessionEvent[] = [
            {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: "the provider is down",
            },
        ];
        const { agent, goals, provider } = await goalAgent("failing-agent", [
            failedTurn,
            failedTurn,
            failedTurn,
        ]);
        await goals.setGoal(ctx, "failing-agent", "ship the thing");

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await agent.send(ctx, user("keep going"), { await: true });
            await agent.waitForIdle();
        }
        await agent.close();

        // Each failed turn ends the work rather than asking for another, so the only turns that
        // ran are the three the messages asked for.
        expect(provider.sessions[0]?.requests).toHaveLength(3);
        expect((await goals.goal(ctx, "failing-agent"))?.status).toBe("blocked");
    });

    it("offers the three goal tools to the model", async () => {
        const { agent, provider } = await goalAgent("tools-agent", [textTurn("answered")]);

        await agent.send(ctx, user("hello"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.options.tools?.map((tool) => tool.name)).toEqual([
            "create_goal",
            "get_goal",
            "update_goal",
        ]);
    });
});
