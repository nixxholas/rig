import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openSessionDatabase } from "../database/openSessionDatabase.js";
import { inTx } from "../inTx.js";

describe("inTx", () => {
    it("passes the database transaction to the operation", async () => {
        const opened = await openSessionDatabase(":memory:");
        let receivedDatabase = true;

        await inTx(opened.database, (tx) => {
            receivedDatabase = "$client" in tx;
        });

        expect(receivedDatabase).toBe(false);
        await opened.database.close();
    });

    it("keeps nested operations on the top-level transaction", async () => {
        const opened = await openSessionDatabase(":memory:");
        await opened.database.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));
        let outerTx: unknown;
        let innerTx: unknown;

        await inTx(opened.database, async (tx) => {
            outerTx = tx;
            await inTx(tx, async (nested) => {
                innerTx = nested;
                await nested.run(sql`INSERT INTO values_log (value) VALUES ('nested')`);
            });
        });

        expect(innerTx).toBe(outerTx);
        expect(
            await opened.database.all<{ value: string }>(sql`SELECT value FROM values_log`),
        ).toEqual([{ value: "nested" }]);
        await opened.database.close();
    });

    it("rolls the whole top-level operation back when a nested mutation fails", async () => {
        const opened = await openSessionDatabase(":memory:");
        await opened.database.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));

        await expect(
            inTx(opened.database, async (tx) => {
                await tx.run(sql`INSERT INTO values_log (value) VALUES ('outer')`);
                await inTx(tx, async (nested) => {
                    await nested.run(sql`INSERT INTO values_log (value) VALUES ('inner')`);
                    throw new Error("fail");
                });
            }),
        ).rejects.toThrow("fail");
        expect(await opened.database.all(sql`SELECT value FROM values_log`)).toEqual([]);
        await opened.database.close();
    });
});
