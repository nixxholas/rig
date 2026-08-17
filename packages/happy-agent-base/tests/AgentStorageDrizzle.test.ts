import { sql } from "drizzle-orm";
import {
    afterCommit,
    createContextNamespace,
    createRootContext,
    type Context,
} from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    AgentStorage,
    AgentSystemLocal,
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    withAgentDatabase,
    type AgentDatabase,
    type AgentModule,
    type AgentStorageLock,
    type AnyAgentTool,
} from "../sources/index.js";
import { inMemoryStorageLock, providersOf, textTurn, user } from "./gym/fixtures.js";
import { inMemoryDrizzle } from "./gym/InMemoryDrizzle.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("agent-storage-drizzle-test");

function lock(): (ctx: Context) => Promise<AgentStorageLock> {
    return inMemoryStorageLock();
}

describe("AgentStorage Drizzle persistence", () => {
    it("runs ordered module migrations once before beforeStart and provides the database", async () => {
        const { close, database } = inMemoryDrizzle();
        const events: string[] = [];
        const module: AgentModule<AnyAgentTool, typeof database> = {
            name: "sample",
            migrations: [
                [
                    "001-create",
                    async (_migrationCtx, migrationDatabase) => {
                        events.push("migration:001");
                        await agentDatabaseRun(
                            migrationDatabase,
                            sql`CREATE TABLE sample_module (value TEXT NOT NULL)`,
                        );
                    },
                ],
                [
                    "002-seed",
                    async (_migrationCtx, migrationDatabase) => {
                        events.push("migration:002");
                        await agentDatabaseRun(
                            migrationDatabase,
                            sql`INSERT INTO sample_module (value) VALUES ('ready')`,
                        );
                    },
                ],
            ],
            beforeStart: async (startCtx) => {
                expect(startCtx.db).toBe(database);
                const rows = await agentDatabaseRows<{ value: string }>(
                    startCtx.db,
                    sql`SELECT value FROM sample_module`,
                );
                expect(rows).toEqual([{ value: "ready" }]);
                events.push("beforeStart");
                return {
                    instructions: (_moduleCtx, scope) => {
                        expect(_moduleCtx.db).toBe(database);
                        expect(scope.agent.id).toBeDefined();
                        return "";
                    },
                };
            },
        };
        const config = {
            modules: [module],
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        };

        const first = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            config,
        );
        await first.close(ctx);
        const second = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            config,
        );
        await second.close(ctx);

        expect(events).toEqual(["migration:001", "migration:002", "beforeStart", "beforeStart"]);
        close();
    });

    it("rolls back a failed migration marker and never reaches beforeStart", async () => {
        const { close, database } = inMemoryDrizzle();
        let beforeStart = 0;
        const module: AgentModule = {
            name: "failing",
            migrations: [
                [
                    "001-fails",
                    async (_migrationCtx, migrationDatabase) => {
                        await agentDatabaseRun(
                            migrationDatabase,
                            sql`CREATE TABLE rolled_back_module (value TEXT NOT NULL)`,
                        );
                        throw new Error("migration failed");
                    },
                ],
            ],
            beforeStart: () => {
                beforeStart += 1;
            },
        };
        const storage = new AgentStorage({ acquireLock: lock(), database });

        await expect(
            AgentSystemLocal.create(ctx, storage, {
                modules: [module],
                providers: providersOf(new ScriptedProvider([])),
                provider: "scripted",
                models: [],
            }),
        ).rejects.toThrow("migration failed");

        expect(beforeStart).toBe(0);
        const markers = await agentDatabaseRows<{ migration_key: string }>(
            database,
            sql`SELECT migration_key FROM happy_agent_migrations WHERE module_key = 'failing'`,
        );
        expect(markers).toEqual([]);
        close();
    });

    it("runs afterCommit immediately outside a transaction and after a successful outer commit", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const events: string[] = [];
        const nestedValue = createContextNamespace("nested-transaction-value", "missing");

        await new Promise<void>((resolve) => {
            afterCommit(ctx, () => {
                events.push("immediate");
                resolve();
            });
        });
        await storage.kv.transaction(ctx, async (kv, txCtx) => {
            await kv.write(txCtx, "value", "committed");
            afterCommit(txCtx, async () => {
                events.push(String(await storage.kv.read(ctx, "value")));
            });
            afterCommit(ctx, () => {
                events.push("unrelated context");
            });
            events.push("inside");
            await nestedValue.set(txCtx, "preserved").inTx(async (nestedCtx) => {
                expect(nestedValue.get(nestedCtx)).toBe("preserved");
            });
        });

        expect(events).toEqual(["immediate", "inside", "unrelated context", "committed"]);
        await expect(
            storage.kv.transaction(ctx, async (kv, txCtx) => {
                await kv.write(txCtx, "rolled-back", true);
                afterCommit(txCtx, () => {
                    events.push("must not run");
                });
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");
        expect(await storage.kv.read(ctx, "rolled-back")).toBeUndefined();
        expect(events).not.toContain("must not run");

        await storage.kv.write(ctx, "literal%.one", 1);
        await storage.kv.write(ctx, "literal_else", 2);
        await storage.kv.write(ctx, "Case.one", 3);
        await storage.kv.write(ctx, "case.two", 4);
        await storage.kv.write(ctx, "😀.one", 5);
        await storage.kv.write(ctx, "😀x.two", 6);
        expect(await storage.kv.list(ctx, "literal%.")).toEqual([
            { key: "literal%.one", value: 1 },
        ]);
        expect(await storage.kv.list(ctx, "Case.")).toEqual([{ key: "Case.one", value: 3 }]);
        expect(await storage.kv.list(ctx, "😀.")).toEqual([{ key: "😀.one", value: 5 }]);
        close();
    });

    it("exposes the root database and active transaction through ctx.db and ctx.inTx", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootCtx = withAgentDatabase(ctx, database);
        expect(rootCtx.db).toBe(database);
        let retainedCtx: Context | undefined;
        const events: string[] = [];

        await rootCtx.inTx(async (txCtx) => {
            retainedCtx = txCtx;
            expect(txCtx.db).not.toBe(database);
            expect(agentDatabase(txCtx)).toBe(txCtx.db);
            await storage.kv.write(txCtx, "host-value", "ready");
            await txCtx.inTx(async (nestedCtx) => {
                expect(nestedCtx.db).toBe(txCtx.db);
                afterCommit(nestedCtx, () => {
                    events.push("afterCommit");
                });
            });
            events.push("execute:return");
        });

        expect(events).toEqual(["execute:return", "afterCommit"]);
        expect(await storage.kv.read(rootCtx, "host-value")).toBe("ready");
        const endedCtx = retainedCtx;
        if (endedCtx === undefined) throw new Error("Transaction context was not captured.");
        expect(() => endedCtx.db).toThrow("has ended");
        await expect(endedCtx.inTx(async () => undefined)).rejects.toThrow("has ended");
        close();
    });

    it("rolls back ctx.inTx work and drops queued post-commit callbacks", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootCtx = withAgentDatabase(ctx, database);
        const events: string[] = [];

        await expect(
            rootCtx.inTx(async (txCtx) => {
                await storage.kv.write(txCtx, "rolled-back", true);
                afterCommit(txCtx, () => {
                    events.push("must not run");
                });
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");

        expect(await storage.kv.read(rootCtx, "rolled-back")).toBeUndefined();
        expect(events).toEqual([]);
        close();
    });

    it("leaves independent transaction scheduling to the database driver", async () => {
        type TransactionWork = (transaction: AgentDatabase) => Promise<unknown>;
        const database = {
            transaction: async (work: TransactionWork) => await work(database as AgentDatabase),
        } as unknown as AgentDatabase;
        const rootCtx = withAgentDatabase(ctx, database);
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            firstEntered = resolve;
        });
        let secondEntered!: () => void;
        const overlapping = new Promise<void>((resolve) => {
            secondEntered = resolve;
        });
        const first = rootCtx.inTx(async () => {
            firstEntered();
            await firstGate;
        });
        await entered;
        const second = rootCtx.inTx(async () => {
            secondEntered();
        });

        await overlapping;
        releaseFirst();
        await Promise.all([first, second]);
    });

    it("rejects ctx.db and ctx.inTx when no agent database is installed", async () => {
        expect(() => ctx.db).toThrow("no agent database");
        await expect(ctx.inTx(async () => undefined)).rejects.toThrow("no agent database");
    });

    it("reuses database context extensions when modules are evaluated again", async () => {
        const firstContexts = await import("../sources/AgentContexts.js");
        const { close, database } = inMemoryDrizzle();
        const firstCtx = firstContexts.withAgentDatabase(createRootContext(), database);
        expect(firstCtx.db).toBe(database);

        vi.resetModules();
        const reloadedContexts = await import("../sources/AgentContexts.js");
        const reloadedTransactions = await import("../sources/inTx.js");
        const reloadedCtx = reloadedContexts.withAgentDatabase(createRootContext(), database);

        expect(reloadedCtx.db).toBe(database);
        expect(firstContexts.agentDatabase(reloadedCtx)).toBe(database);
        await reloadedCtx.inTx(async (txCtx) => {
            await reloadedTransactions.inTx(txCtx, async (nestedCtx) => {
                expect(nestedCtx.db).toBe(txCtx.db);
            });
        });
        close();
    });

    it("keeps storage key-value transactions on the same ctx.inTx facade", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootCtx = withAgentDatabase(ctx, database);
        let activeDatabase: AgentDatabase | undefined;

        await rootCtx.inTx(async (txCtx) => {
            activeDatabase = txCtx.db;
            await storage.kv.transaction(txCtx, async (kv, nestedCtx) => {
                expect(nestedCtx.db).toBe(activeDatabase);
                await kv.write(nestedCtx, "nested-value", "ready");
            });
        });

        expect(activeDatabase).toBeDefined();
        expect(activeDatabase).not.toBe(database);
        expect(await storage.kv.read(rootCtx, "nested-value")).toBe("ready");
        close();
    });

    it("rejects a root context reused inside a transaction instead of leaking its writes", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);

        await expect(
            withAgentDatabase(ctx, database).inTx(async (txCtx) => {
                await expect(storage.kv.write(ctx, "wrong-context", true)).rejects.toThrow(
                    "must use that transaction's context",
                );
                await storage.kv.write(txCtx, "rolled-back", true);
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");

        expect(await storage.kv.read(ctx, "wrong-context")).toBeUndefined();
        expect(await storage.kv.read(ctx, "rolled-back")).toBeUndefined();
        close();
    });

    it("routes foreign root contexts to the right store and rejects foreign transactions", async () => {
        const first = inMemoryDrizzle();
        const second = inMemoryDrizzle();
        const firstStorage = new AgentStorage({
            acquireLock: lock(),
            database: first.database,
        });
        const secondStorage = new AgentStorage({
            acquireLock: lock(),
            database: second.database,
        });
        await firstStorage.migrate(ctx, []);
        await secondStorage.migrate(ctx, []);
        const firstRootCtx = withAgentDatabase(ctx, first.database);

        await secondStorage.kv.write(firstRootCtx, "belongs-to-second", true);
        expect(await firstStorage.kv.read(ctx, "belongs-to-second")).toBeUndefined();
        expect(await secondStorage.kv.read(ctx, "belongs-to-second")).toBe(true);

        await withAgentDatabase(ctx, first.database).inTx(async (firstTxCtx) => {
            await expect(
                secondStorage.kv.write(firstTxCtx, "must-not-cross", true),
            ).rejects.toThrow("another agent storage");
        });
        expect(await firstStorage.kv.read(ctx, "must-not-cross")).toBeUndefined();
        expect(await secondStorage.kv.read(ctx, "must-not-cross")).toBeUndefined();
        first.close();
        second.close();
    });

    it("queues live send and steer messages inside an outer transaction and starts after commit", async () => {
        const { close, database } = inMemoryDrizzle();
        const provider = new ScriptedProvider([textTurn("steered"), textTurn("committed")]);
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();
        const rootCtx = withAgentDatabase(ctx, database);

        const accepted = await rootCtx.inTx(async (txCtx) => {
            const result = await system.send(txCtx, agent.id, user("inside transaction"), {
                await: true,
                id: "h12345678901234567890123",
            });
            expect(
                await agent.steer(txCtx, user("transactional steering"), {
                    id: "h12345678901234567890127",
                }),
            ).toEqual({
                accepted: "created",
                delivery: "steer",
                id: "h12345678901234567890127",
            });
            expect(result.accepted).toBe("created");
            expect(agent.active).toBe(false);
            expect(provider.sessions).toEqual([]);
            return result;
        });

        expect(accepted).toEqual({
            accepted: "created",
            delivery: "send",
            id: "h12345678901234567890123",
        });
        await agent.waitForIdle();
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("transactional steering"),
        );
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(
            user("inside transaction"),
        );
        await system.close(ctx);
        close();
    });

    it("loads an idle stored target to deliver a transactional message", async () => {
        const { close, database } = inMemoryDrizzle();
        const setup = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(new ScriptedProvider([])), provider: "scripted", models: [] },
        );
        const created = await setup.create(ctx, {});
        await created.waitForIdle();
        await setup.close(ctx);

        // A fresh process instantiates only agents with work left, so the target is not live.
        const provider = new ScriptedProvider([textTurn("delivered")]);
        const system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(provider), provider: "scripted", models: [] },
        );
        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            expect(
                await system.send(txCtx, created.id, user("load on delivery"), {
                    id: "h12345678901234567890141",
                }),
            ).toEqual({
                accepted: "created",
                delivery: "send",
                id: "h12345678901234567890141",
            });
            expect(provider.sessions).toEqual([]);
        });
        const agent = await system.resolve(ctx, created.id);
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("load on delivery"),
        );
        await system.close(ctx);
        close();
    });

    it("leaves a target loaded by a rolled-back transactional send idle with no live effect", async () => {
        const { close, database } = inMemoryDrizzle();
        const setup = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(new ScriptedProvider([])), provider: "scripted", models: [] },
        );
        const created = await setup.create(ctx, {});
        await created.waitForIdle();
        await setup.close(ctx);

        const provider = new ScriptedProvider([textTurn("after rollback")]);
        const system = await AgentSystemLocal.create(
            ctx,
            new AgentStorage({ acquireLock: lock(), database }),
            { providers: providersOf(provider), provider: "scripted", models: [] },
        );
        await expect(
            withAgentDatabase(ctx, database).inTx(async (txCtx) => {
                await system.send(txCtx, created.id, user("rolled back"), {
                    id: "h12345678901234567890142",
                });
                throw new Error("roll back the load");
            }),
        ).rejects.toThrow("roll back the load");

        // The loaded object is live but was never started and owes nothing durable.
        expect(provider.sessions).toEqual([]);
        await system.send(ctx, created.id, user("after rollback"), { await: true });
        const agent = await system.resolve(ctx, created.id);
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("after rollback"),
        ]);
        await system.close(ctx);
        close();
    });

    it("claims a distinct queue key for every send inside one transaction", async () => {
        const { close, database } = inMemoryDrizzle();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await agent.send(txCtx, user("first in transaction"), {
                id: "h12345678901234567890131",
            });
            await agent.send(txCtx, user("second in transaction"), {
                id: "h12345678901234567890132",
            });
        });
        await agent.waitForIdle();

        // Both sends landed under their own key and arrive in the order they were accepted.
        const requests = provider.sessions[0]?.requests ?? [];
        const seen = requests.at(-1)?.context.messages ?? [];
        const first = seen.findIndex(
            (message) => JSON.stringify(message) === JSON.stringify(user("first in transaction")),
        );
        const second = seen.findIndex(
            (message) => JSON.stringify(message) === JSON.stringify(user("second in transaction")),
        );
        expect(first).toBeGreaterThanOrEqual(0);
        expect(second).toBeGreaterThan(first);
        await system.close(ctx);
        close();
    });

    it("reloads a transactional message committed while the target is already running", async () => {
        const { close, database } = inMemoryDrizzle();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let releaseInference!: () => void;
        const inferenceMayContinue = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        let inferenceEntered!: () => void;
        const inInference = new Promise<void>((resolve) => {
            inferenceEntered = resolve;
        });
        let blockFirstInference = true;
        const gate: AgentModule = {
            name: "transactional-message-gate",
            beforeStart: () => ({
                beforeInference: async () => {
                    if (!blockFirstInference) return;
                    blockFirstInference = false;
                    inferenceEntered();
                    await inferenceMayContinue;
                },
            }),
        };
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            modules: [gate],
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.send(ctx, user("already running"), { await: true });
        await inInference;

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await agent.send(txCtx, user("committed while running"), {
                id: "h12345678901234567890125",
            });
            expect(provider.sessions[0]?.requests).toEqual([]);
        });
        releaseInference();
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests).toHaveLength(2);
        expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toEqual(
            user("already running"),
        );
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual(
            user("committed while running"),
        );
        await system.close(ctx);
        close();
    });

    it("drops every live effect when an outer transactional send rolls back", async () => {
        const { close, database } = inMemoryDrizzle();
        const provider = new ScriptedProvider([textTurn("retried")]);
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();
        const rootCtx = withAgentDatabase(ctx, database);
        const messageId = "h12345678901234567890124";

        await expect(
            rootCtx.inTx(async (txCtx) => {
                expect(
                    await agent.send(txCtx, user("rolled back"), {
                        await: false,
                        id: messageId,
                    }),
                ).toEqual({
                    accepted: "created",
                    delivery: "send",
                    id: messageId,
                });
                expect(agent.active).toBe(false);
                expect(provider.sessions).toEqual([]);
                throw new Error("roll back message");
            }),
        ).rejects.toThrow("roll back message");

        expect(agent.active).toBe(false);
        expect(provider.sessions).toEqual([]);
        expect(
            await agent.send(ctx, user("retry after rollback"), {
                await: false,
                id: messageId,
            }),
        ).toEqual({
            accepted: "created",
            delivery: "send",
            id: messageId,
        });
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            user("retry after rollback"),
        ]);
        await system.close(ctx);
        close();
    });

    it("rejects other live agent and system commands from an outer storage transaction", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});
        await agent.waitForIdle();

        await withAgentDatabase(ctx, database).inTx(async (txCtx) => {
            await expect(
                system.create(txCtx, {}, { id: "h12345678901234567890123" }),
            ).rejects.toThrow("outer storage transaction");
            await expect(system.delete(txCtx, agent.id)).rejects.toThrow(
                "outer storage transaction",
            );
            await expect(agent.updateMetadata(txCtx, { title: "not committed" })).rejects.toThrow(
                "outer storage transaction",
            );
            await expect(agent.compact(txCtx)).rejects.toThrow("outer storage transaction");
            await expect(agent.abort(txCtx)).rejects.toThrow("outer storage transaction");
            await expect(system.resolve(txCtx, agent.id)).rejects.toThrow(
                "outer storage transaction",
            );
            await expect(system.close(txCtx)).rejects.toThrow("outer storage transaction");
        });

        // Nothing the refused calls attempted was written, so the agent still holds exactly the
        // configuration it was created with: where it came from, and nothing else.
        expect(await system.config(ctx, agent.id)).toEqual({
            provenance: { createdAt: expect.any(Number) },
        });
        await system.close(ctx);
        close();
    });
});
