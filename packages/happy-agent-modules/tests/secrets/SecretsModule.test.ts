import { describe, expect, it } from "vitest";

import { moduleDatabase } from "../support/moduleDatabase.js";
import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { SECRETS_MIGRATION_KEY, secretsMigrations } from "../../sources/secrets/SecretDatabase.js";

describe("SecretsModule", () => {
    it("owns a stable migration and persists safe metadata", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-test");
        await database.ready;
        try {
            expect(secretsMigrations.map(([key]) => key)).toEqual([SECRETS_MIGRATION_KEY]);
            const module = new SecretsModule({
                idFactory: () => "secret-1",
                eventIdFactory: () => "event-1",
            });
            const reference = await module.register(database.context, "agent-a", {
                description: "A token",
                environment: { TOKEN: "never returned to the model" },
            });

            expect(reference).toEqual({
                id: "secret-1",
                description: "A token",
                environmentVariables: ["TOKEN"],
                revision: "1",
            });
            expect(await module.reference(database.context, "agent-a", "secret-1")).toEqual(
                reference,
            );
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "secret-1"),
            ).resolves.toEqual({
                scopeRef: "scope-1",
                secretId: "secret-1",
            });
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "secret-1"),
            ).resolves.toEqual({
                scopeRef: "scope-1",
                secretId: "secret-1",
            });

            const restarted = new SecretsModule({
                idFactory: () => "secret-2",
                eventIdFactory: () => "event-2",
            });
            expect(await restarted.reference(database.context, "agent-a", "secret-1")).toEqual(
                reference,
            );
        } finally {
            database.close();
        }
    });

    it("retains only the external host resolver capability and rejects injected stores", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-resolver-test");
        await database.ready;
        try {
            const module = new SecretsModule({
                resolveForHost: async () => ({ TOKEN: "host-only" }),
            });
            await module.register(database.context, "agent-a", {
                id: "secret-1",
                description: "A token",
                environment: { TOKEN: "database value" },
            });

            expect(await module.resolveForHost(database.context, "agent-a", "scope-1")).toEqual({
                TOKEN: "host-only",
            });
            expect(
                () =>
                    new SecretsModule({
                        store: {},
                    } as never),
            ).toThrow("options are invalid");
        } finally {
            database.close();
        }
    });

    it("lists and validates scoped attachments in one context transaction", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-list-snapshot-test");
        await database.ready;
        let listAuthorizationWasTransactional = false;
        const module = new SecretsModule({
            authorize: async (ctx, _agentId, operation) => {
                if (operation === "list") {
                    listAuthorizationWasTransactional = ctx.db !== database.database;
                }
                return true;
            },
        });
        try {
            await module.register(database.context, "agent-a", {
                id: "secret-1",
                description: "A token",
                environment: { TOKEN: "host-only" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "secret-1");

            await expect(
                module.list(database.context, "agent-a", { scopeRef: "scope-1" }),
            ).resolves.toMatchObject({
                secrets: [expect.objectContaining({ id: "secret-1" })],
            });
            expect(listAuthorizationWasTransactional).toBe(true);
        } finally {
            database.close();
        }
    });
});
