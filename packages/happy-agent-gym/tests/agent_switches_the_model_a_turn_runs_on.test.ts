import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    GYM_MODEL_ID,
    GYM_PROVIDER_ID,
    GYM_SECOND_MODEL_ID,
    type AgentGym,
} from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

interface CatalogModel {
    readonly defaultThinkingLevel: string;
    readonly id: string;
    readonly name: string;
    readonly thinkingLevels: readonly string[];
}

interface Catalog {
    readonly defaultModelId: string;
    readonly defaultProviderId: string;
    readonly models: readonly CatalogModel[];
    readonly providers: readonly {
        readonly models: readonly CatalogModel[];
        readonly providerId: string;
        readonly serviceTiers?: readonly string[];
    }[];
}

/** Ask for a message with a selection a scenario names in full, including the invalid parts. */
async function submit(
    gym: AgentGym,
    selection: {
        readonly effort: string;
        readonly modelId: string;
        readonly providerId: string;
        readonly serviceTier: "fast" | null;
    },
) {
    return await gym.http.post<{ readonly error: string }>(
        `/v0/sessions/${gym.rootSessionId}/messages`,
        { ...selection, text: "Run this somewhere." },
    );
}

describe("the agent tells a client which models it can run on", () => {
    it("lists both of the provider's models, under the one provider that serves them", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const models = await gym.http.ok<{ readonly catalog: Catalog }>("GET", "/v0/models");
        const catalog = models.catalog;

        expect(catalog.models.map((model) => model.id)).toEqual([
            GYM_MODEL_ID,
            GYM_SECOND_MODEL_ID,
        ]);
        expect(catalog.models.map((model) => model.name)).toEqual(["Gym Model", "Gym Model Two"]);
        expect(catalog.models[0]?.thinkingLevels).toEqual(["low", "medium", "high"]);
        expect(catalog.models[0]?.defaultThinkingLevel).toBe("medium");
        expect(catalog.defaultModelId).toBe(GYM_MODEL_ID);
        expect(catalog.defaultProviderId).toBe(GYM_PROVIDER_ID);

        const provider = catalog.providers[0];
        expect(catalog.providers).toHaveLength(1);
        expect(provider?.providerId).toBe(GYM_PROVIDER_ID);
        expect(provider?.models.map((model) => model.id)).toEqual([
            GYM_MODEL_ID,
            GYM_SECOND_MODEL_ID,
        ]);
        // The gym provider declares no priority tier, so the catalog names none — which is the
        // same fact that makes a "fast" request below a refusal rather than a slower turn.
        expect(provider?.serviceTiers).toBeUndefined();

        // The startup snapshot a client opens with carries the identical catalog, so a picker
        // built from either route offers the same models.
        const startup = await gym.http.ok<{ readonly catalog: Catalog }>("GET", "/v0/catalog");
        expect(startup.catalog).toEqual(catalog);
        expect(gym.errors).toEqual([]);
    });
});

describe("the agent runs a turn on the model the message named", () => {
    it("sends the second turn to the second model and shows it the erased conversation", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "Answered by the first model.", type: "text" }] },
                { content: [{ text: "Answered by the second model.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Ask the first model.");
        await gym.send("Ask the second model.", { modelId: GYM_SECOND_MODEL_ID });

        expect(gym.inference.requests.map((request) => request.model)).toEqual([
            GYM_MODEL_ID,
            GYM_SECOND_MODEL_ID,
        ]);

        // Gym models share no model family, so the switch resets the conversation and the model
        // switch notice is what the second model is given in place of the history it lost.
        const notice = gym.inference.last?.messages[0];
        expect(notice?.role).toBe("system");
        const noticeText = JSON.stringify(notice);
        expect(noticeText).toContain("changed from Gym Model on gym to Gym Model Two on gym");
        expect(noticeText).toContain("read_agent_history");
        expect(noticeText).toContain("Answered by the first model.");

        // The chat itself now runs on the second model, and says so to a client.
        expect(await gym.getSession()).toMatchObject({
            effort: "medium",
            modelId: GYM_SECOND_MODEL_ID,
            providerId: GYM_PROVIDER_ID,
        });
        const changed = (await gym.sessionEvents()).filter(
            (event) => event.type === "session_configuration_changed",
        );
        expect(changed).toHaveLength(1);
        expect(changed[0]?.data).toMatchObject({
            changed: ["model"],
            modelId: GYM_SECOND_MODEL_ID,
            providerId: GYM_PROVIDER_ID,
        });
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("refuses a model, a provider, an effort and a tier the catalog cannot serve", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const unknownModel = await submit(gym, {
            effort: "medium",
            modelId: "gym/model-3",
            providerId: GYM_PROVIDER_ID,
            serviceTier: null,
        });
        expect(unknownModel.status).toBe(400);
        expect(unknownModel.body.error).toBe(
            `Model "gym/model-3" is not available in this agent's model catalog.`,
        );

        const otherProvider = await submit(gym, {
            effort: "medium",
            modelId: GYM_MODEL_ID,
            providerId: "codex",
            serviceTier: null,
        });
        expect(otherProvider.status).toBe(400);
        expect(otherProvider.body.error).toBe(
            `Model "gym/model" is not served by provider "codex".`,
        );

        const unservedEffort = await submit(gym, {
            effort: "ultra",
            modelId: GYM_MODEL_ID,
            providerId: GYM_PROVIDER_ID,
            serviceTier: null,
        });
        expect(unservedEffort.status).toBe(400);
        expect(unservedEffort.body.error).toBe(
            `Effort "ultra" is not supported by model "gym/model" for provider "gym".`,
        );

        const unservedTier = await submit(gym, {
            effort: "medium",
            modelId: GYM_MODEL_ID,
            providerId: GYM_PROVIDER_ID,
            serviceTier: "fast",
        });
        expect(unservedTier.status).toBe(400);
        expect(unservedTier.body.error).toBe(
            `A priority service tier is not supported by model "gym/model" for provider "gym".`,
        );

        // A refused message never reaches a model, and never moves the chat off its own selection.
        expect(gym.inference.requests).toEqual([]);
        expect(await gym.getSession()).toMatchObject({ modelId: GYM_MODEL_ID });

        // A deliberate refusal is not an unexpected daemon fault.
        expect(gym.errors).toEqual([]);
    });
});
