import { sql } from "drizzle-orm";
import {
    afterCommit,
    createContextNamespace,
    createRootContext,
    withAfterCommit,
    type Context,
} from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentStorage,
    AgentSystemLocal,
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    withAgentDatabase,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModule,
    type AgentStorageLock,
    type AgentStorageTransaction,
    type AnyAgentTool,
} from "../sources/index.js";
import { inMemoryStorageLock, providersOf } from "./gym/fixtures.js";
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
            beforeStart: async (_startCtx, _agents, moduleDatabase) => {
                const exactDatabase: typeof database = moduleDatabase;
                expect(moduleDatabase).toBe(database);
                const rows = await agentDatabaseRows<{ value: string }>(
                    exactDatabase,
                    sql`SELECT value FROM sample_module`,
                );
                expect(rows).toEqual([{ value: "ready" }]);
                events.push("beforeStart");
            },
            instructions: (_moduleCtx, scope) => {
                const exactDatabase: AgentDatabaseFacade<typeof database> = scope.database;
                expect(exactDatabase).toBeDefined();
                return "";
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
            await storage.transaction(nestedValue.set(txCtx, "preserved"), async (nestedCtx) => {
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

    it("uses a host-supplied transaction with stdlib afterCommit and its active facade", async () => {
        const { close, database } = inMemoryDrizzle();
        const state = createContextNamespace<
            | {
                  readonly database: AgentDatabase;
              }
            | undefined
        >("agent-storage-test-transaction", undefined);
        const transaction: AgentStorageTransaction = async (transactionCtx, work) => {
            const nested = state.get(transactionCtx);
            if (nested !== undefined) return await work(transactionCtx, nested.database);
            let runAfterCommit!: () => Promise<void>;
            const result = await database.transaction(async (activeDatabase) => {
                const [activeCtx, drain] = withAfterCommit(
                    state.set(transactionCtx, {
                        database: activeDatabase,
                    }),
                );
                runAfterCommit = drain;
                return await work(activeCtx, activeDatabase);
            });
            await runAfterCommit();
            return result;
        };
        const storage = new AgentStorage({
            acquireLock: lock(),
            database,
            transaction,
        });
        await storage.migrate(ctx, []);
        let activeDatabase: AgentDatabase | undefined;
        let observed = "";

        await storage.kv.transaction(ctx, async (kv, txCtx) => {
            activeDatabase = agentDatabase(txCtx);
            await kv.write(txCtx, "host-value", "ready");
            afterCommit(txCtx, async () => {
                observed = String(await storage.kv.read(ctx, "host-value"));
            });
        });

        expect(activeDatabase).toBeDefined();
        expect(activeDatabase).not.toBe(database);
        expect(observed).toBe("ready");
        close();
    });

    it("accepts transaction integration without a separate post-commit option", async () => {
        const { close, database } = inMemoryDrizzle();
        const transaction: AgentStorageTransaction = async (transactionCtx, work) => {
            let runAfterCommit!: () => Promise<void>;
            const result = await database.transaction(async (activeDatabase) => {
                const [activeCtx, drain] = withAfterCommit(transactionCtx);
                runAfterCommit = drain;
                return await work(activeCtx, activeDatabase);
            });
            await runAfterCommit();
            return result;
        };
        const storage = new AgentStorage({
            acquireLock: lock(),
            database,
            transaction,
        });
        await storage.migrate(ctx, []);
        const events: string[] = [];
        await storage.transaction(ctx, async (txCtx) => {
            afterCommit(txCtx, () => {
                events.push("committed");
            });
        });
        expect(events).toEqual(["committed"]);
        close();
    });

    it("serializes concurrent default SQLite transactions", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);

        await Promise.all(
            Array.from({ length: 20 }, async (_, index) => {
                await storage.kv.transaction(ctx, async (kv, txCtx) => {
                    await kv.write(txCtx, `concurrent.${index}`, index);
                    await Promise.resolve();
                });
            }),
        );

        expect(await storage.kv.list(ctx, "concurrent.")).toHaveLength(20);
        close();
    });

    it("rejects a root context reused inside a transaction instead of leaking its writes", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);

        await expect(
            storage.transaction(ctx, async (txCtx) => {
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

    it("coordinates root database contexts without mistaking them for active transactions", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        await storage.migrate(ctx, []);
        const rootDatabaseCtx = withAgentDatabase(ctx, database);
        let entered!: () => void;
        let release!: () => void;
        const transactionEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const transactionRelease = new Promise<void>((resolve) => {
            release = resolve;
        });
        const rollingBack = storage.transaction(rootDatabaseCtx, async (txCtx) => {
            await storage.kv.write(txCtx, "rolled-back", true);
            entered();
            await transactionRelease;
            throw new Error("roll back");
        });
        await transactionEntered;

        const outsideWrite = storage.kv.write(rootDatabaseCtx, "outside", true);
        release();
        await expect(rollingBack).rejects.toThrow("roll back");
        await outsideWrite;

        expect(await storage.kv.read(ctx, "rolled-back")).toBeUndefined();
        expect(await storage.kv.read(ctx, "outside")).toBe(true);
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

        await firstStorage.transaction(ctx, async (firstTxCtx) => {
            await expect(
                secondStorage.kv.write(firstTxCtx, "must-not-cross", true),
            ).rejects.toThrow("another agent storage");
        });
        expect(await firstStorage.kv.read(ctx, "must-not-cross")).toBeUndefined();
        expect(await secondStorage.kv.read(ctx, "must-not-cross")).toBeUndefined();
        first.close();
        second.close();
    });

    it("rejects live agent and system commands from an outer storage transaction", async () => {
        const { close, database } = inMemoryDrizzle();
        const storage = new AgentStorage({ acquireLock: lock(), database });
        const system = await AgentSystemLocal.create(ctx, storage, {
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: [],
        });
        const agent = await system.create(ctx, {});

        await storage.transaction(ctx, async (txCtx) => {
            await expect(
                system.create(txCtx, {}, { id: "h12345678901234567890123" }),
            ).rejects.toThrow("outer storage transaction");
            await expect(system.delete(txCtx, agent.id)).rejects.toThrow(
                "outer storage transaction",
            );
            await expect(agent.send(txCtx, { role: "user", content: [] })).rejects.toThrow(
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

        expect(await system.config(ctx, agent.id)).toEqual({});
        await system.close(ctx);
        close();
    });
});
