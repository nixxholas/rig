import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { Agent, FeatureGoals } from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("feature-goals-test");

describe("FeatureGoals", () => {
    it("provides one goal tool and an active initial goal", () => {
        const feature = new FeatureGoals({ objective: "Ship the feature" });

        expect(feature.name).toBe("goals");
        expect(feature.updateGoalTool.name).toBe("update_goal");
        expect(feature.goal).toEqual({
            objective: "Ship the feature",
            status: "active",
        });
    });

    it("persists caller-controlled pause and restores it in a new feature instance", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            goalToolTurn("blocked"),
            textTurn("Waiting for user input."),
        ]);
        const feature = new FeatureGoals({ objective: "Ship safely" });
        const agent = new Agent(ctx, {
            id: "paused-goal-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            features: [feature],
        });

        await agent.send(ctx, user("Begin."), { await: true });
        await agent.waitForIdle();
        expect(feature.goal.status).toBe("blocked");

        const writeValue = persistence.writeValue.bind(persistence);
        persistence.writeValue = (_writeCtx, key, value) =>
            key === "kv.paused-goal-agent.feature.goals.goal"
                ? Promise.reject(new Error("storage offline"))
                : writeValue(_writeCtx, key, value);
        await expect(feature.resume(ctx)).rejects.toThrow("storage offline");
        expect(feature.goal.status).toBe("blocked");
        persistence.writeValue = writeValue;

        await expect(feature.resume(ctx)).resolves.toMatchObject({ status: "active" });
        feature.onEvent(ctx, { type: "done", state: "cancelled" });
        await expect(feature.afterAgentLoop(ctx)).resolves.toBeUndefined();
        await expect(feature.afterAgentLoop(ctx)).resolves.toHaveLength(1);
        await expect(feature.pause(ctx)).resolves.toMatchObject({ status: "paused" });
        expect(persistence.values.get("kv.paused-goal-agent.feature.goals.goal")).toEqual({
            objective: "Ship safely",
            status: "paused",
        });
        await agent.close();

        const restoredProvider = new ScriptedProvider([]);
        const restoredFeature = new FeatureGoals({ objective: "Ignored replacement" });
        const restoredAgent = new Agent(ctx, {
            id: "paused-goal-agent",
            providers: providersOf(restoredProvider),
            provider: "scripted",
            persistence,
            features: [restoredFeature],
        });
        restoredAgent.start();
        await restoredAgent.waitForIdle();

        expect(restoredFeature.goal).toEqual({
            objective: "Ship safely",
            status: "paused",
        });
        expect(restoredProvider.sessions).toHaveLength(0);
        await restoredAgent.close();
    });

    it("keeps running through Agent until the model completes the goal", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            textTurn("Still working."),
            goalToolTurn("complete"),
            textTurn("The goal is complete."),
        ]);
        const feature = new FeatureGoals({
            objective: "Finish <all> & verify\nKeep this line unchanged",
        });
        const agent = new Agent(ctx, {
            id: "goal-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            features: [feature],
        });

        await agent.send(ctx, user("Begin."), { await: true });
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(provider.sessions[0]?.options.tools?.map((tool) => tool.name)).toEqual([
            "update_goal",
        ]);
        expect(requests[1]?.context.messages.at(-1)).toMatchObject({
            role: "user",
            content: [
                {
                    type: "text",
                    text: expect.stringContaining(
                        "<objective>\nFinish &lt;all&gt; &amp; verify\nKeep this line unchanged\n</objective>",
                    ),
                },
            ],
        });
        expect(feature.goal.status).toBe("complete");
        expect(persistence.values.get("kv.goal-agent.feature.goals.goal")).toEqual({
            objective: "Finish <all> & verify\nKeep this line unchanged",
            status: "complete",
        });
        await expect(feature.resume(ctx)).rejects.toThrow("completed goal cannot be resumed");
        await expect(feature.pause(ctx)).rejects.toThrow("completed goal cannot be paused");
        await agent.close();

        const restoredProvider = new ScriptedProvider([]);
        const restoredFeature = new FeatureGoals({ objective: "Ignored replacement" });
        const restoredAgent = new Agent(ctx, {
            id: "goal-agent",
            providers: providersOf(restoredProvider),
            provider: "scripted",
            persistence,
            features: [restoredFeature],
        });
        restoredAgent.start();
        await restoredAgent.waitForIdle();
        expect(restoredFeature.goal).toEqual(feature.goal);
        expect(restoredProvider.sessions).toHaveLength(0);
        await restoredAgent.close();
    });

    it("rejects an empty objective", () => {
        expect(() => new FeatureGoals({ objective: "   " })).toThrow(
            "Goal objective must be between",
        );
    });
});

function goalToolTurn(status: "blocked" | "complete"): SessionEvent[] {
    return [
        { type: "toolcall_start", callId: `goal-${status}`, name: "update_goal" },
        {
            type: "toolcall_end",
            callId: `goal-${status}`,
            arguments: JSON.stringify({ status }),
        },
        {
            type: "done",
            state: "tool_call",
            tokens: { input: 1, output: 1 },
        },
    ];
}
