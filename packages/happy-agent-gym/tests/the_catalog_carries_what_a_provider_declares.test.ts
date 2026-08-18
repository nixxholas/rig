import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, GYM_PROVIDER_ID, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

interface CatalogModel {
    readonly compatibility?: string;
    readonly id: string;
    readonly inputTypes?: readonly string[];
    readonly outputTypes?: readonly string[];
}

interface Catalog {
    readonly models: readonly CatalogModel[];
    readonly providers: readonly {
        readonly compatibility?: string;
        readonly inputTypes?: readonly string[];
        readonly models: readonly CatalogModel[];
        readonly outputTypes?: readonly string[];
        readonly providerId: string;
    }[];
}

describe("the catalog carries what a provider declares", () => {
    it("names the modalities and the compatibility group of every model it offers", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const catalog = (await gym.http.ok<{ readonly catalog: Catalog }>("GET", "/v0/models"))
            .catalog;

        // The gym provider accepts text and images and answers in text, and it was registered
        // under the "gym" compatibility group. A client can only offer an image, or decide that
        // switching models keeps the conversation, if the catalog says so.
        for (const model of catalog.models) {
            expect(model.inputTypes).toEqual(["text", "image"]);
            expect(model.outputTypes).toEqual(["text"]);
            expect(model.compatibility).toBe("gym");
        }
        expect(catalog.models).toHaveLength(2);

        const provider = catalog.providers[0];
        expect(provider?.providerId).toBe(GYM_PROVIDER_ID);
        expect(provider?.inputTypes).toEqual(["text", "image"]);
        expect(provider?.outputTypes).toEqual(["text"]);
        expect(provider?.compatibility).toBe("gym");
        expect(provider?.models.map((model) => model.compatibility)).toEqual(["gym", "gym"]);

        // Every route that serves a catalog serves the same one, so a picker built from the
        // startup snapshot knows exactly what a picker built from the model list knows.
        const startup = await gym.http.ok<{ readonly catalog: Catalog }>("GET", "/v0/catalog");
        const health = await gym.http.ok<{ readonly catalog: Catalog }>("GET", "/v0/health");
        expect(startup.catalog).toEqual(catalog);
        expect(health.catalog).toEqual(catalog);
        expect(gym.errors).toEqual([]);
    });
});
