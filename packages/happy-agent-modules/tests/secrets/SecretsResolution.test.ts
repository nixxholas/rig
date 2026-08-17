import { describe, expect, it, vi } from "vitest";

import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { secretsMigrations } from "../../sources/secrets/SecretDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const AGENT = "agent-a";

async function withDatabase<T>(
    name: string,
    callback: (
        database: ModuleDatabase & {
            readonly database: import("@slopus/happy-agent-base").AgentDatabase;
        },
    ) => Promise<T>,
): Promise<T> {
    const database = moduleDatabase(secretsMigrations, name);
    await database.ready;
    try {
        return await callback(database);
    } finally {
        database.close();
    }
}

async function registerAndAttach(
    module: SecretsModule,
    database: ModuleDatabase,
    id: string,
    environment: Record<string, string>,
    scopeRef = "scope-1",
    availableToModel?: boolean,
): Promise<void> {
    await module.register(database.context, AGENT, {
        id,
        description: id,
        environment,
        ...(availableToModel === undefined ? {} : { availableToModel }),
    });
    await module.attach(database.context, AGENT, scopeRef, id);
}

describe("SecretsModule host and command resolution", () => {
    it("resolves only attached secrets by default and supports explicit, empty, and cloned selections", async () => {
        await withDatabase("secrets-resolution-host", async (database) => {
            const module = new SecretsModule();
            await registerAndAttach(module, database, "attached", { ATTACHED: "one" });
            await module.register(database.context, AGENT, {
                id: "unattached",
                description: "unattached",
                environment: { UNATTACHED: "two" },
            });

            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1"),
            ).resolves.toEqual({ ATTACHED: "one" });
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", ["attached"]),
            ).resolves.toEqual({ ATTACHED: "one" });
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", []),
            ).resolves.toEqual({});
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", ["unattached"]),
            ).rejects.toThrow("not attached");

            const selected = await module.resolveForHost(database.context, AGENT, "scope-1", [
                "attached",
            ]);
            selected.ATTACHED = "caller mutation";
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", ["attached"]),
            ).resolves.toEqual({ ATTACHED: "one" });
        });
    });

    it("uses the trusted host resolver only on the host API and passes selection identity intact", async () => {
        await withDatabase("secrets-resolution-injected-host", async (database) => {
            const calls: Array<readonly unknown[]> = [];
            const resolver = vi.fn(async (...args: unknown[]) => {
                calls.push(args);
                return { RESOLVED: "host-only-value" };
            });
            const module = new SecretsModule({ resolveForHost: resolver });
            await registerAndAttach(module, database, "one", { ONE: "database-value" });

            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1"),
            ).resolves.toEqual({ RESOLVED: "host-only-value" });
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", []),
            ).resolves.toEqual({ RESOLVED: "host-only-value" });
            expect(resolver).toHaveBeenCalledTimes(2);
            expect(calls[0]?.slice(1)).toEqual([AGENT, "scope-1", undefined]);
            expect(calls[1]?.slice(1)).toEqual([AGENT, "scope-1", []]);

            const tools = module.beforeStart();
            const toolText = JSON.stringify(tools);
            expect(toolText).not.toContain("host-only-value");
            expect(toolText).not.toContain("database-value");
        });
    });

    it("allows a trusted host to resolve host-only attachments while command resolution rejects them", async () => {
        await withDatabase("secrets-resolution-availability", async (database) => {
            const module = new SecretsModule();
            await registerAndAttach(module, database, "managed", {
                HOST_TOKEN: "host-only-value",
            });
            await module.update(database.context, AGENT, "managed", {
                availableToModel: false,
            });

            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1"),
            ).resolves.toEqual({ HOST_TOKEN: "host-only-value" });
            await expect(
                module.resolveForCommand(database.context, AGENT, "scope-1"),
            ).rejects.toThrow("not available to agent commands");
            await expect(
                module.resolveForCommand(database.context, AGENT, "scope-1", ["managed"]),
            ).rejects.toThrow("not available to agent commands");
        });
    });

    it("rejects invalid selections before a resolver can observe them", async () => {
        await withDatabase("secrets-resolution-selection", async (database) => {
            const resolver = vi.fn(async () => ({}));
            const module = new SecretsModule({ resolveForHost: resolver });
            await registerAndAttach(module, database, "one", { TOKEN: "value" });

            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", ["one", "one"]),
            ).rejects.toThrow("selection is invalid");
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", ["missing"]),
            ).rejects.toThrow("not attached");
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-1", ["bad id"]),
            ).rejects.toThrow("selection is invalid");
            expect(resolver).not.toHaveBeenCalled();
        });
    });

    it("merges command resolver entries deterministically and hides attached names case-insensitively", async () => {
        await withDatabase("secrets-resolution-command", async (database) => {
            const calls: string[][] = [];
            const module = new SecretsModule({
                resolveForCommand: async (_ctx, _agentId, _scopeRef, ids) => {
                    calls.push([...ids]);
                    return [
                        { secretId: "second", environment: { zed: "two" } },
                        { secretId: "first", environment: { TOKEN: "one" } },
                    ];
                },
            });
            await registerAndAttach(module, database, "first", { TOKEN: "db-one", Ambient: "a" });
            await registerAndAttach(module, database, "second", { zed: "db-two" });

            await expect(
                module.resolveForCommand(database.context, AGENT, "scope-1"),
            ).resolves.toEqual({
                environment: { TOKEN: "one", zed: "two" },
                hiddenEnvironmentVariables: ["Ambient", "TOKEN", "zed"],
            });
            expect(calls).toEqual([["first", "second"]]);
            await expect(
                module.resolveForCommand(database.context, AGENT, "scope-1", ["second"]),
            ).rejects.toThrow("did not return every selected secret");
        });
    });

    it("rejects command resolver omissions, extras, duplicates, and case-insensitive collisions", async () => {
        await withDatabase("secrets-resolution-command-contracts", async (database) => {
            const setup = new SecretsModule();
            await registerAndAttach(setup, database, "first", { TOKEN: "one" });
            await registerAndAttach(setup, database, "second", { OTHER: "two" });

            const cases: Array<{
                name: string;
                result: unknown;
                message: string;
            }> = [
                {
                    name: "missing",
                    result: [{ secretId: "first", environment: { TOKEN: "one" } }],
                    message: "did not return every selected secret",
                },
                {
                    name: "extra",
                    result: [
                        { secretId: "first", environment: { TOKEN: "one" } },
                        { secretId: "second", environment: { OTHER: "two" } },
                        { secretId: "third", environment: { THIRD: "three" } },
                    ],
                    message: "did not return every selected secret",
                },
                {
                    name: "duplicate",
                    result: [
                        { secretId: "first", environment: { TOKEN: "one" } },
                        { secretId: "first", environment: { OTHER: "two" } },
                    ],
                    message: "unexpected secret identity",
                },
                {
                    name: "collision",
                    result: [
                        { secretId: "first", environment: { TOKEN: "one" } },
                        { secretId: "second", environment: { token: "two" } },
                    ],
                    message: "both define",
                },
            ];
            for (const testCase of cases) {
                const module = new SecretsModule({
                    resolveForCommand: async () => testCase.result as never,
                });
                await expect(
                    module.resolveForCommand(database.context, AGENT, "scope-1"),
                    testCase.name,
                ).rejects.toThrow(testCase.message);
            }
        });
    });

    it("rejects invalid resolver environments and values at the trusted boundary", async () => {
        await withDatabase("secrets-resolution-invalid-results", async (database) => {
            const invalidResults: unknown[] = [
                { TOKEN: "nul\u0000value" },
                { "1NOT_VALID": "value" },
                { TOKEN: "value", token: "collision" },
                { TOKEN: "x".repeat(65_537) },
                Object.fromEntries(
                    Array.from({ length: 257 }, (_, index) => [`VAR_${index}`, "value"]),
                ),
            ];
            for (const result of invalidResults) {
                const module = new SecretsModule({
                    resolveForHost: async () => result as never,
                });
                await expect(
                    module.resolveForHost(database.context, AGENT, "scope-1"),
                ).rejects.toThrow("resolver returned");
            }
        });
    });
});
