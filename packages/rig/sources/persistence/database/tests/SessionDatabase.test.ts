import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { inTx } from "../../inTx.js";
import { withDatabase } from "../../databaseContext.js";
import type { DatabaseScope } from "../../Transaction.js";
import { inDatabase } from "../inDatabase.js";
import { migrateSessionDatabase } from "../migrateSessionDatabase.js";
import { openSessionDatabase, SessionDatabaseClosedError } from "../openSessionDatabase.js";
import { sessions } from "../schema.js";

describe("SessionDatabase", () => {
    it("serializes plain operations through its connection lock", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const order: string[] = [];

        await Promise.all([
            inDatabase(opened.ctx, "rig.sql.test.first", async () => {
                order.push("first-start");
                await Promise.resolve();
                order.push("first-end");
            }),
            inDatabase(opened.ctx, "rig.sql.test.second", async () => {
                order.push("second-start");
                order.push("second-end");
            }),
            inDatabase(
                withDatabase(opened.ctx, opened.database.database),
                "rig.sql.test.raw",
                async () => {
                    order.push("raw");
                },
            ),
        ]);

        expect(order).toEqual(["first-start", "first-end", "second-start", "second-end", "raw"]);
        await opened.database.close(opened.ctx);
    });

    it("reuses a transaction-scoped context without reacquiring the database lock", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        await opened.ctx.tx.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));

        let outer: unknown;
        let inner: unknown;
        let innerDatabase: unknown;
        await inTx(opened.ctx, "rig.sql.test.outer", async (ctx) => {
            outer = ctx.tx;
            await ctx.tx.run(sql`INSERT INTO values_log (value) VALUES ('outer')`);
            await inTx(ctx, "rig.sql.test.inner", async (nestedCtx) => {
                inner = nestedCtx.tx;
                await nestedCtx.tx.run(sql`INSERT INTO values_log (value) VALUES ('inner')`);
            });
            await inDatabase(ctx, "rig.sql.test.inner_database", async (nestedCtx) => {
                innerDatabase = nestedCtx.tx;
                await nestedCtx.tx.run(
                    sql`INSERT INTO values_log (value) VALUES ('inner-database')`,
                );
            });
        });

        expect(inner).toBe(outer);
        expect(innerDatabase).toBe(outer);
        expect(await opened.ctx.tx.all(sql`SELECT value FROM values_log ORDER BY value`)).toEqual([
            { value: "inner" },
            { value: "inner-database" },
            { value: "outer" },
        ]);
        await opened.database.close(opened.ctx);
    });

    it("rejects foreign and stale transaction contexts", async () => {
        const root = createTestRootContext();
        const first = await openSessionDatabase(root, ":memory:");
        const second = await openSessionDatabase(root, ":memory:");
        let stale: DatabaseScope | undefined;
        let foreign: DatabaseScope | undefined;
        let releaseForeign!: () => void;
        let markForeignReady!: () => void;
        const foreignReady = new Promise<void>((resolve) => {
            markForeignReady = resolve;
        });
        const foreignGate = new Promise<void>((resolve) => {
            releaseForeign = resolve;
        });
        const foreignRun = inTx(second.ctx, "rig.sql.test.foreign", async (ctx) => {
            foreign = ctx.tx;
            markForeignReady();
            await foreignGate;
        });
        try {
            await foreignReady;
            const foreignCtx = withDatabase(root, foreign!);
            await expect(
                inDatabase(foreignCtx, "rig.sql.test.foreign_database", async () => {}),
            ).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "foreign",
            });
            await expect(
                inTx(foreignCtx, "rig.sql.test.foreign_transaction", async () => {}),
            ).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "foreign",
            });
            await inTx(first.ctx, "rig.sql.test.first", async (ctx) => {
                stale = ctx.tx;
                await expect(
                    inDatabase(foreignCtx, "rig.sql.test.cross_database", async () => {}),
                ).rejects.toMatchObject({
                    name: "SessionDatabaseTransactionError",
                    reason: "foreign",
                });
                await expect(
                    inTx(foreignCtx, "rig.sql.test.cross_transaction", async () => {}),
                ).rejects.toMatchObject({
                    name: "SessionDatabaseTransactionError",
                    reason: "foreign",
                });
            });

            const staleCtx = withDatabase(root, stale!);
            await expect(
                inDatabase(staleCtx, "rig.sql.test.stale_database", async () => {}),
            ).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "stale",
            });
            await expect(
                inTx(staleCtx, "rig.sql.test.stale_transaction", async () => {}),
            ).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "stale",
            });
        } finally {
            releaseForeign();
            await foreignRun;
            await Promise.all([first.database.close(first.ctx), second.database.close(second.ctx)]);
        }
    });

    it("drains admitted work and rejects new work while closing", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        let release!: () => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const admitted = opened.database.runInLock(opened.ctx, async () => {
            markStarted();
            await gate;
        });
        await started;

        const closing = opened.database.close(opened.ctx);
        expect(opened.database.closing).toBe(true);
        expect(opened.database.closed).toBe(false);
        await expect(opened.database.runInLock(opened.ctx, async () => {})).rejects.toBeInstanceOf(
            SessionDatabaseClosedError,
        );
        await expect(
            inDatabase(opened.ctx, "rig.sql.test.closing", async () => {}),
        ).rejects.toMatchObject({
            name: "SessionDatabaseClosedError",
            state: "closing",
        });

        release();
        await admitted;
        await closing;
        expect(opened.database.closed).toBe(true);
        await expect(
            inDatabase(opened.ctx, "rig.sql.test.closed", async () => {}),
        ).rejects.toMatchObject({
            name: "SessionDatabaseClosedError",
            state: "closed",
        });
        await opened.database.close(opened.ctx);
    });

    it("closes the client once when close is requested concurrently", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const clientClose = vi.spyOn(opened.client, "close");

        const first = opened.database.close(opened.ctx);
        const second = opened.database.close(opened.ctx);
        await Promise.all([first, second]);

        expect(clientClose).toHaveBeenCalledTimes(1);
        expect(opened.database.closed).toBe(true);
    });

    it("allows a repeated close after the first client close rejects", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const failure = new Error("close failed");
        const clientClose = vi.spyOn(opened.client, "close").mockImplementationOnce(() => {
            throw failure;
        });

        try {
            await expect(opened.database.close(opened.ctx)).rejects.toBe(failure);
            await expect(opened.database.close(opened.ctx)).resolves.toBeUndefined();
            expect(opened.database.closed).toBe(true);
            expect(clientClose).toHaveBeenCalledTimes(1);
        } finally {
            clientClose.mockRestore();
            opened.client.close();
        }
    });

    it("returns undefined for absent rows through both raw and builder reads", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        await migrateSessionDatabase(opened.ctx);

        expect(
            await opened.ctx.tx.get<{ value: string }>(sql.raw("SELECT id FROM sessions LIMIT 1")),
        ).toBeUndefined();
        expect(
            await opened.ctx.tx
                .select()
                .from(sessions)
                .where(sql`false`)
                .get(),
        ).toBeUndefined();

        await opened.database.close(opened.ctx);
    });
});
