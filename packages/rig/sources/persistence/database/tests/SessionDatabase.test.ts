import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { inDatabase } from "../inDatabase.js";
import { inTx } from "../../inTx.js";
import { migrateSessionDatabase } from "../migrateSessionDatabase.js";
import { openSessionDatabase, SessionDatabaseClosedError } from "../openSessionDatabase.js";
import { sessions } from "../schema.js";
import type { DatabaseScope } from "../../Transaction.js";

describe("SessionDatabase", () => {
    it("serializes plain operations through its connection lock", async () => {
        const opened = await openSessionDatabase(":memory:");
        const order: string[] = [];

        await Promise.all([
            inDatabase(opened.database, async () => {
                order.push("first-start");
                await Promise.resolve();
                order.push("first-end");
            }),
            inDatabase(opened.database, async () => {
                order.push("second-start");
                order.push("second-end");
            }),
            inDatabase(opened.database.database, async () => {
                order.push("raw");
            }),
        ]);

        expect(order).toEqual(["first-start", "first-end", "second-start", "second-end", "raw"]);
        await opened.database.close();
    });

    it("reuses a transaction-scoped handle without reacquiring the database lock", async () => {
        const opened = await openSessionDatabase(":memory:");
        await opened.database.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));

        let outer: unknown;
        let inner: unknown;
        let innerDatabase: unknown;
        await inTx(opened.database, async (tx) => {
            outer = tx;
            await tx.run(sql`INSERT INTO values_log (value) VALUES ('outer')`);
            await inTx(tx, async (nested) => {
                inner = nested;
                await nested.run(sql`INSERT INTO values_log (value) VALUES ('inner')`);
            });
            await inDatabase(tx, async (nested) => {
                innerDatabase = nested;
                await nested.run(sql`INSERT INTO values_log (value) VALUES ('inner-database')`);
            });
        });

        expect(inner).toBe(outer);
        expect(innerDatabase).toBe(outer);
        expect(await opened.database.all(sql`SELECT value FROM values_log ORDER BY value`)).toEqual(
            [{ value: "inner" }, { value: "inner-database" }, { value: "outer" }],
        );
        await opened.database.close();
    });

    it("rejects foreign and stale transaction scopes", async () => {
        const first = await openSessionDatabase(":memory:");
        const second = await openSessionDatabase(":memory:");
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
        const foreignRun = inTx(second.database, async (tx) => {
            foreign = tx;
            markForeignReady();
            await foreignGate;
        });
        try {
            await foreignReady;
            await expect(inDatabase(foreign!, async () => {})).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "foreign",
            });
            await expect(inTx(foreign!, async () => {})).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "foreign",
            });
            await inTx(first.database, async (tx) => {
                stale = tx;
                await expect(inDatabase(foreign!, async () => {})).rejects.toMatchObject({
                    name: "SessionDatabaseTransactionError",
                    reason: "foreign",
                });
                await expect(inTx(foreign!, async () => {})).rejects.toMatchObject({
                    name: "SessionDatabaseTransactionError",
                    reason: "foreign",
                });
            });

            await expect(inDatabase(stale!, async () => {})).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "stale",
            });
            await expect(inTx(stale!, async () => {})).rejects.toMatchObject({
                name: "SessionDatabaseTransactionError",
                reason: "stale",
            });
        } finally {
            releaseForeign();
            await foreignRun;
            await Promise.all([first.database.close(), second.database.close()]);
        }
    });

    it("drains admitted work and rejects new work while closing", async () => {
        const opened = await openSessionDatabase(":memory:");
        let release!: () => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const admitted = opened.database.runInLock(async () => {
            markStarted();
            await gate;
        });
        await started;

        const closing = opened.database.close();
        expect(opened.database.closing).toBe(true);
        expect(opened.database.closed).toBe(false);
        await expect(opened.database.runInLock(async () => {})).rejects.toBeInstanceOf(
            SessionDatabaseClosedError,
        );
        await expect(inDatabase(opened.database, async () => {})).rejects.toMatchObject({
            name: "SessionDatabaseClosedError",
            state: "closing",
        });

        release();
        await admitted;
        await closing;
        expect(opened.database.closed).toBe(true);
        await expect(inDatabase(opened.database, async () => {})).rejects.toMatchObject({
            name: "SessionDatabaseClosedError",
            state: "closed",
        });
        await opened.database.close();
    });

    it("closes the client once when close is requested concurrently", async () => {
        const opened = await openSessionDatabase(":memory:");
        const clientClose = vi.spyOn(opened.client, "close");

        const first = opened.database.close();
        const second = opened.database.close();
        await Promise.all([first, second]);

        expect(clientClose).toHaveBeenCalledTimes(1);
        expect(opened.database.closed).toBe(true);
    });

    it("allows a repeated close after the first client close rejects", async () => {
        const opened = await openSessionDatabase(":memory:");
        const failure = new Error("close failed");
        const clientClose = vi.spyOn(opened.client, "close").mockImplementationOnce(() => {
            throw failure;
        });

        try {
            await expect(opened.database.close()).rejects.toBe(failure);
            await expect(opened.database.close()).resolves.toBeUndefined();
            expect(opened.database.closed).toBe(true);
            expect(clientClose).toHaveBeenCalledTimes(1);
        } finally {
            clientClose.mockRestore();
            opened.client.close();
        }
    });

    it("returns undefined for absent rows through both raw and builder reads", async () => {
        const opened = await openSessionDatabase(":memory:");
        await migrateSessionDatabase(opened.database);

        expect(
            await opened.database.get<{ value: string }>(
                sql.raw("SELECT id FROM sessions LIMIT 1"),
            ),
        ).toBeUndefined();
        expect(
            await opened.database
                .select()
                .from(sessions)
                .where(sql`false`)
                .get(),
        ).toBeUndefined();

        await opened.database.close();
    });
});
