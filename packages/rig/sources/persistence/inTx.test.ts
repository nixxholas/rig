import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openSessionDatabase } from "./database/openSessionDatabase.js";
import { inTx } from "./inTx.js";

describe("inTx", () => {
    it("passes the database transaction to the operation", () => {
        const opened = openSessionDatabase(":memory:");
        let receivedDatabase = true;

        inTx(opened.database, (tx) => {
            receivedDatabase = "$client" in tx;
        });

        expect(receivedDatabase).toBe(false);
        opened.client.close();
    });

    it("keeps nested operations on the top-level transaction", () => {
        const opened = openSessionDatabase(":memory:");
        opened.database.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));
        let outerTx: unknown;
        let innerTx: unknown;

        inTx(opened.database, (tx) => {
            outerTx = tx;
            inTx(tx, (nested) => {
                innerTx = nested;
                nested.run(sql`INSERT INTO values_log (value) VALUES ('nested')`);
            });
        });

        expect(innerTx).toBe(outerTx);
        expect(opened.database.all<{ value: string }>(sql`SELECT value FROM values_log`)).toEqual([
            { value: "nested" },
        ]);
        opened.client.close();
    });

    it("rolls the whole top-level operation back when a nested mutation fails", () => {
        const opened = openSessionDatabase(":memory:");
        opened.database.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));

        expect(() =>
            inTx(opened.database, (tx) => {
                tx.run(sql`INSERT INTO values_log (value) VALUES ('outer')`);
                inTx(tx, (nested) => {
                    nested.run(sql`INSERT INTO values_log (value) VALUES ('inner')`);
                    throw new Error("fail");
                });
            }),
        ).toThrow("fail");
        expect(opened.database.all(sql`SELECT value FROM values_log`)).toEqual([]);
        opened.client.close();
    });
});
