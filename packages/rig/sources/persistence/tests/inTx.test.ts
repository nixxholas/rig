import { type Span, type Tracer } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { openSessionDatabase } from "../database/openSessionDatabase.js";
import { inTx } from "../inTx.js";

describe("inTx", () => {
    it("derives an active transaction context for successful work", async () => {
        const traced = recordingContext();
        const opened = await openSessionDatabase(traced.ctx, ":memory:");
        traced.names.length = 0;
        let receivedDatabase = true;

        await inTx(opened.ctx, "rig.sql.test.transaction", (ctx) => {
            receivedDatabase = "$client" in ctx.tx;
        });

        expect(receivedDatabase).toBe(false);
        expect(traced.names).toEqual(["rig.sql.test.transaction"]);
        await opened.database.close(opened.ctx);
    });

    it("keeps nested operations on the same active transaction", async () => {
        const traced = recordingContext();
        const opened = await openSessionDatabase(traced.ctx, ":memory:");
        await opened.ctx.tx.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));
        traced.names.length = 0;
        let outerTx: unknown;
        let innerTx: unknown;

        await inTx(opened.ctx, "rig.sql.test.outer", async (ctx) => {
            outerTx = ctx.tx;
            await inTx(ctx, "rig.sql.test.inner", async (nestedCtx) => {
                innerTx = nestedCtx.tx;
                await nestedCtx.tx.run(sql`INSERT INTO values_log (value) VALUES ('nested')`);
            });
        });

        expect(innerTx).toBe(outerTx);
        expect(
            await opened.ctx.tx.all<{ value: string }>(sql`SELECT value FROM values_log`),
        ).toEqual([{ value: "nested" }]);
        expect(traced.names).toEqual(["rig.sql.test.outer", "rig.sql.test.inner"]);
        await opened.database.close(opened.ctx);
    });

    it("rolls back the top-level transaction and marks both spans on nested failure", async () => {
        const traced = recordingContext();
        const opened = await openSessionDatabase(traced.ctx, ":memory:");
        await opened.ctx.tx.run(sql.raw("CREATE TABLE values_log (value TEXT NOT NULL)"));
        traced.names.length = 0;
        traced.errors.length = 0;

        await expect(
            inTx(opened.ctx, "rig.sql.test.outer", async (ctx) => {
                await ctx.tx.run(sql`INSERT INTO values_log (value) VALUES ('outer')`);
                await inTx(ctx, "rig.sql.test.inner", async (nestedCtx) => {
                    await nestedCtx.tx.run(sql`INSERT INTO values_log (value) VALUES ('inner')`);
                    throw new Error("fail");
                });
            }),
        ).rejects.toThrow("fail");

        expect(await opened.ctx.tx.all(sql`SELECT value FROM values_log`)).toEqual([]);
        expect(traced.errors).toHaveLength(2);
        expect(traced.names).toEqual(["rig.sql.test.outer", "rig.sql.test.inner"]);
        await opened.database.close(opened.ctx);
    });
});

function recordingContext(): {
    ctx: ReturnType<typeof createTestRootContext>;
    errors: unknown[];
    names: string[];
} {
    const names: string[] = [];
    const errors: unknown[] = [];
    const tracer = {
        startSpan: vi.fn((name: string) => {
            names.push(name);
            return {
                end: vi.fn(),
                recordException: (error: unknown) => errors.push(error),
                setAttributes: vi.fn(),
                setStatus: vi.fn(),
            } as unknown as Span;
        }),
    } as unknown as Tracer;
    return { ctx: createTestRootContext(tracer), errors, names };
}
