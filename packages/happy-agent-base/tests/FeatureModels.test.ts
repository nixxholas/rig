import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBaseKV,
    AgentStorage,
    AgentSystemLocal,
    FeatureModels,
    withAgentSystem,
} from "../sources/index.js";
import { providersOf } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("feature-models-test");

describe("FeatureModels", () => {
    it("lists available provider/model routes and their effort levels", async () => {
        const owner = new AgentSystemLocal({
            features: [],
            storage: new AgentStorage({
                kv: new AgentBaseKV(
                    new InMemoryPersistence(),
                    "agents.",
                    async (operationCtx, work) => work(operationCtx),
                ),
                persistence: () => new InMemoryPersistence(),
            }),
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [
                {
                    providerId: "scripted",
                    id: "openai/test",
                    name: "Test model",
                    effortLevels: ["low", "medium", "high"],
                    defaultEffort: "medium",
                    serviceTiers: ["priority"],
                },
            ],
        });
        const feature = new FeatureModels();
        await feature.load(withAgentSystem(ctx, owner));

        expect(feature.instructions()).toBe(
            [
                "# Available models",
                "You can run subagents with any of these models. When overriding a child's inherited selection, pass the provider and model ID exactly as shown and use one of the listed effort levels:",
                "- scripted: Test model (`openai/test`) — effort levels: low, medium (default), high; service tiers: priority",
            ].join("\n"),
        );
    });
});
