import { describe, expect, it } from "vitest";

import { runSqliteTransaction, type SqliteTransactionHandle } from "./runSqliteTransaction.js";

function handle(
    options: {
        commit?: () => Promise<void>;
        rollback?: () => Promise<void>;
        close?: () => void;
    } = {},
): SqliteTransactionHandle {
    return {
        close: options.close ?? (() => undefined),
        commit: options.commit ?? (async () => undefined),
        rollback: options.rollback ?? (async () => undefined),
    };
}

describe("runSqliteTransaction", () => {
    it("preserves the primary operation error", async () => {
        const failure = new Error("operation failed");

        await expect(
            runSqliteTransaction(handle(), async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
    });

    it("aggregates primary, rollback, and close failures", async () => {
        const primary = new Error("operation failed");
        const rollback = new Error("rollback failed");
        const close = new Error("close failed");

        try {
            await runSqliteTransaction(
                handle({
                    close: () => {
                        throw close;
                    },
                    rollback: async () => {
                        throw rollback;
                    },
                }),
                async () => {
                    throw primary;
                },
            );
            throw new Error("expected transaction failure");
        } catch (error) {
            expect(error).toBeInstanceOf(AggregateError);
            expect((error as AggregateError).errors).toEqual([primary, rollback, close]);
        }
    });

    it("keeps a commit failure primary when rollback cleanup fails", async () => {
        const commit = new Error("commit failed");
        const rollback = new Error("rollback failed");

        try {
            await runSqliteTransaction(
                handle({
                    commit: async () => {
                        throw commit;
                    },
                    rollback: async () => {
                        throw rollback;
                    },
                }),
                async () => undefined,
            );
            throw new Error("expected transaction failure");
        } catch (error) {
            expect(error).toBeInstanceOf(AggregateError);
            expect((error as AggregateError).errors).toEqual([commit, rollback]);
        }
    });
});
