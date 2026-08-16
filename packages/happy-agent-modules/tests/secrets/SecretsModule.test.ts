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

    it("enforces host-only references and reserves managed credential IDs", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-policy-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            for (const id of ["github", "GitHub", "GITHUB", "gItHuB"]) {
                await expect(
                    module.register(database.context, "agent-a", {
                        id,
                        description: "Spoofed GitHub token",
                        environment: { GH_TOKEN: "token" },
                    }),
                ).rejects.toThrow("reserved for GitHub CLI credentials");
            }
            for (const id of ["project-git", "PROJECT-GIT", "Project-Git"]) {
                await expect(
                    module.register(database.context, "agent-a", {
                        id,
                        description: "Spoofed project Git token",
                        environment: { GIT_TOKEN: "token" },
                    }),
                ).rejects.toThrow("reserved for managed project Git access");
            }

            await module.register(database.context, "agent-a", {
                id: "managed",
                description: "Host credential",
                environment: { TOKEN: "host-only" },
                availableToModel: false,
            });
            await expect(
                module.reference(database.context, "agent-a", "managed"),
            ).resolves.toMatchObject({
                id: "managed",
                availableToModel: false,
            });
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "managed"),
            ).rejects.toThrow("cannot be attached to agent commands");

            await expect(
                module.update(database.context, "agent-a", "managed", {
                    availableToModel: true,
                }),
            ).resolves.toMatchObject({ availableToModel: true });
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "managed"),
            ).resolves.toEqual({
                scopeRef: "scope-1",
                secretId: "managed",
            });
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1"),
            ).resolves.toEqual({
                environment: { TOKEN: "host-only" },
                hiddenEnvironmentVariables: ["TOKEN"],
            });
            await expect(
                module.update(database.context, "agent-a", "managed", {
                    availableToModel: false,
                }),
            ).resolves.toMatchObject({ availableToModel: false });
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1"),
            ).rejects.toThrow("not available to agent commands");
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1", ["managed"]),
            ).rejects.toThrow("not available to agent commands");
        } finally {
            database.close();
        }
    });

    it("rejects colliding selected environments and returns command hiding metadata", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-command-resolution-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            await module.register(database.context, "agent-a", {
                id: "first",
                description: "First",
                environment: { TOKEN: "first" },
            });
            await module.register(database.context, "agent-a", {
                id: "second",
                description: "Second",
                environment: { token: "second", OTHER: "second" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "second");
            await module.attach(database.context, "agent-a", "scope-1", "first");

            await expect(
                module.resolveForHost(database.context, "agent-a", "scope-1"),
            ).rejects.toThrow("both define token");
            await expect(
                module.resolveForHost(database.context, "agent-a", "scope-1", ["first"]),
            ).resolves.toEqual({ TOKEN: "first" });
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1", ["first"]),
            ).resolves.toEqual({
                environment: { TOKEN: "first" },
                hiddenEnvironmentVariables: ["OTHER", "TOKEN"],
            });
        } finally {
            database.close();
        }
    });

    it("validates an injected command resolver and preserves its selected result", async () => {
        const database = moduleDatabase(
            secretsMigrations,
            "secrets-command-resolver-contract-test",
        );
        await database.ready;
        try {
            const calls: unknown[][] = [];
            const module = new SecretsModule({
                resolveForCommand: async (...args) => {
                    calls.push(args);
                    return [{ secretId: "selected", environment: { DYNAMIC_TOKEN: "host-only" } }];
                },
            });
            await module.register(database.context, "agent-a", {
                id: "selected",
                description: "Selected",
                environment: { TOKEN: "database-value" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "selected");
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1", ["selected"]),
            ).resolves.toEqual({
                environment: { DYNAMIC_TOKEN: "host-only" },
                hiddenEnvironmentVariables: ["DYNAMIC_TOKEN", "TOKEN"],
            });
            expect(calls).toHaveLength(1);
            expect(calls[0]?.[1]).toBe("agent-a");
            expect(calls[0]?.[2]).toBe("scope-1");
            expect(calls[0]?.[3]).toEqual(["selected"]);

            expect(
                () =>
                    new SecretsModule({
                        resolveForCommand: {} as never,
                    }),
            ).toThrow("options are invalid");
        } finally {
            database.close();
        }
    });

    it("rejects collisions from an injected resolver regardless of result order", async () => {
        const database = moduleDatabase(
            secretsMigrations,
            "secrets-command-resolver-collision-test",
        );
        await database.ready;
        try {
            const module = new SecretsModule({
                resolveForCommand: async () => [
                    { secretId: "second", environment: { token: "second" } },
                    { secretId: "first", environment: { TOKEN: "first" } },
                ],
            });
            await module.register(database.context, "agent-a", {
                id: "first",
                description: "First",
                environment: { TOKEN: "database-first" },
            });
            await module.register(database.context, "agent-a", {
                id: "second",
                description: "Second",
                environment: { token: "database-second" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "second");
            await module.attach(database.context, "agent-a", "scope-1", "first");

            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1"),
            ).rejects.toThrow("both define token");
        } finally {
            database.close();
        }
    });
});
