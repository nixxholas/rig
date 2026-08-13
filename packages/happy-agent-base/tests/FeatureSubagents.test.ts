import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBaseKV,
    AgentStorage,
    AgentSystemLocal,
    FeatureSubagents,
    withAgentBaseContext,
    withAgentSystem,
} from "../sources/index.js";
import { providersOf } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("subagents-test");

describe("FeatureSubagents", () => {
    it("loads its parent ID and owning AgentSystemLocal collection", async () => {
        const persistence = new InMemoryPersistence();
        const owner = new AgentSystemLocal({
            features: [],
            storage: new AgentStorage({
                kv: new AgentBaseKV(persistence, "agents.", async (operationCtx, work) =>
                    work(operationCtx),
                ),
                persistence: () => new InMemoryPersistence(),
            }),
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
        const feature = new FeatureSubagents("parent");

        await feature.load(withAgentSystem(ctx, owner));

        expect(feature.agentId).toBe("parent");
        expect(feature.agentSystem).toBe(owner);
        const featureCtx = withAgentBaseContext(ctx, {
            provider: "scripted",
            model: "openai/test",
            effort: "high",
            serviceTier: "priority",
        });
        expect(feature.instructions(featureCtx)).toContain('Your stable agent path is "parent".');
        expect(feature.instructions(featureCtx)).toContain(
            'Your current provider is "scripted", model is "openai/test", effort is "high", and service tier is "priority".',
        );
    });

    it("requires an agent system context", async () => {
        await expect(new FeatureSubagents("parent").load(ctx)).rejects.toThrow(
            "FeatureSubagents requires an agent system context.",
        );
    });

    it("starts a named child agent with its initial task", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "done" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            [
                { type: "text_start" },
                { type: "text_delta", delta: "acknowledged" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const persistenceByAgent = new Map<string, InMemoryPersistence>();
        const owner = new AgentSystemLocal({
            features: [FeatureSubagents],
            storage: new AgentStorage({
                kv: new AgentBaseKV(
                    new InMemoryPersistence(),
                    "agents.",
                    async (operationCtx, work) => work(operationCtx),
                ),
                persistence: (agentId) => {
                    const persistence = new InMemoryPersistence();
                    persistenceByAgent.set(agentId, persistence);
                    return persistence;
                },
            }),
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const feature = new FeatureSubagents("parent");
        await owner.create(ctx, "parent", {});
        await feature.load(withAgentSystem(ctx, owner));

        const result = await feature.spawnAgentTool.execute(
            withAgentBaseContext(ctx, {
                provider: "scripted",
                model: "openai/child",
                effort: "high",
                serviceTier: "priority",
            }),
            {
                task_name: "audit",
                message: "Review the change.",
            },
        );
        const child = await owner.resolve(ctx, result.agent_id);
        await child.waitForIdle();
        const parent = await owner.resolve(ctx, "parent");
        await parent.waitForIdle();

        expect(result).toEqual({ agent_id: "parent/audit" });
        expect(provider.sessions[0]?.requests[0]?.context.messages[0]).toEqual({
            role: "user",
            content: [{ type: "text", text: "Review the change." }],
        });
        expect(provider.sessions[0]?.requests[0]?.model).toBe("openai/child");
        expect(provider.sessions[0]?.requests[0]?.effort).toBe("high");
        expect(provider.sessions[0]?.requests[0]?.serviceTier).toBe("priority");
        expect(
            persistenceByAgent.get("parent")?.records.find((record) => record.type === "user"),
        ).toMatchObject({
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: expect.stringContaining("<agent_id>parent/audit</agent_id>"),
                    },
                ],
            },
        });
        await child.close();
        await parent.close();
    });
});
