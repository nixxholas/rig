import { describe, expect, it } from "vitest";

import { HistoryModule } from "../../sources/history/HistoryModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("HistoryModule durability", () => {
    it("commits a durable read result inside the one history transaction", async () => {
        let database!: ReturnType<typeof moduleDatabase>;
        let transactionDepth = 0;
        const history = new HistoryModule({
            transaction: async (ctx, work) => {
                transactionDepth += 1;
                try {
                    return await work(ctx, database.database);
                } finally {
                    transactionDepth -= 1;
                }
            },
        });
        database = moduleDatabase(history.migrations, "history-tool-commit-test");
        await database.ready;

        try {
            await history.record(database.context, "agent-a", {
                at: 123,
                blocks: [{ text: "Remember this.", type: "text" }],
                recordId: "history-record-1",
                role: "user",
            });
            const scope = {
                agent: { id: "agent-a" },
            } as Parameters<HistoryModule["tools"]>[1];
            const [tool] = history.tools(database.context, scope);
            let committed: unknown;
            const result = await tool!.execute(database.context, {}, {
                id: "call-history-1",
                providerCallId: "provider-history-1",
                kv: {},
                commit: async (_ctx: unknown, value: unknown) => {
                    expect(transactionDepth).toBe(1);
                    committed = value;
                    return value;
                },
            } as never);

            expect(tool!.durable).toBe(true);
            expect(result).toBe(committed);
            expect(result).toMatchObject({
                matched_messages: 1,
                returned_messages: 1,
                target: "agent-a",
                total_messages: 1,
            });
        } finally {
            database.close();
        }
    });

    it("treats a reused record ID as a conflict instead of a replay no-op", async () => {
        let database!: ReturnType<typeof moduleDatabase>;
        const history = new HistoryModule({
            transaction: async (ctx, work) => await work(ctx, database.database),
        });
        database = moduleDatabase(history.migrations, "history-record-conflict-test");
        await database.ready;

        try {
            const message = {
                at: 123,
                blocks: [{ text: "Only once.", type: "text" as const }],
                recordId: "history-record-1",
                role: "user" as const,
            };
            await history.record(database.context, "agent-a", message);
            await expect(history.record(database.context, "agent-a", message)).rejects.toThrow();
            await expect(history.stats(database.context, "agent-a")).resolves.toMatchObject({
                messages: 1,
            });
        } finally {
            database.close();
        }
    });
});
