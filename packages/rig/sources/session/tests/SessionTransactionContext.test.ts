import { describe, expect, it } from "vitest";

import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    deferSessionTransactionCommit,
    isSessionTransactionPostCommitError,
    runSessionTransaction,
    SessionTransactionPostCommitError,
    sessionTransactionScope,
} from "../SessionTransactionContext.js";

describe("SessionTransactionContext", () => {
    it("awaits an asynchronous callback when no transaction is active", async () => {
        let completed = false;

        await deferSessionTransactionCommit(async () => {
            await Promise.resolve();
            completed = true;
        });

        expect(completed).toBe(true);
    });

    it("propagates immediate callback failures", async () => {
        const failure = new Error("post-commit callback failed");

        await expect(
            deferSessionTransactionCommit(async () => {
                await Promise.resolve();
                throw failure;
            }),
        ).rejects.toBe(failure);
    });

    it("runs deferred callbacks after commit and awaits them", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        try {
            let operationFinished = false;
            let callbackCompleted = false;

            await runSessionTransaction(opened.ctx, async () => {
                await deferSessionTransactionCommit(async () => {
                    expect(operationFinished).toBe(true);
                    await Promise.resolve();
                    callbackCompleted = true;
                });
                operationFinished = true;
            });

            expect(callbackCompleted).toBe(true);
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("propagates deferred callback failures after commit", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const failure = new Error("deferred post-commit callback failed");
        try {
            const transaction = runSessionTransaction(opened.ctx, async () => {
                await deferSessionTransactionCommit(async () => {
                    await Promise.resolve();
                    throw failure;
                });
            });
            await expect(transaction).rejects.toMatchObject({
                cause: failure,
                failures: [failure],
                name: "SessionTransactionPostCommitError",
            });
            await expect(transaction).rejects.toBeInstanceOf(SessionTransactionPostCommitError);
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("runs every deferred callback before reporting their failures", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const firstFailure = new Error("first callback failed");
        const secondFailure = Object.freeze(new Error("second callback failed"));
        const order: string[] = [];
        try {
            const transaction = runSessionTransaction(opened.ctx, async () => {
                await deferSessionTransactionCommit(() => {
                    order.push("first");
                    throw firstFailure;
                });
                await deferSessionTransactionCommit(async () => {
                    order.push("second");
                    await deferSessionTransactionCommit(async () => {
                        await Promise.resolve();
                        order.push("nested-immediate");
                    });
                    throw secondFailure;
                });
                await deferSessionTransactionCommit(() => {
                    order.push("third");
                });
            });

            await expect(transaction).rejects.toMatchObject({
                failures: [firstFailure, secondFailure],
                name: "SessionTransactionPostCommitError",
            });
            expect(order).toEqual(["first", "second", "nested-immediate", "third"]);
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("classifies frozen and primitive post-commit failures through an explicit wrapper", async () => {
        const opened = await openSessionDatabase(createTestRootContext(), ":memory:");
        const frozenFailure = Object.freeze(new Error("frozen callback failure"));
        try {
            const transaction = runSessionTransaction(opened.ctx, async () => {
                await deferSessionTransactionCommit(() => {
                    throw frozenFailure;
                });
            });
            const error = await transaction.catch((caught: unknown) => caught);
            expect(isSessionTransactionPostCommitError(error)).toBe(true);
            expect(error).toMatchObject({ cause: frozenFailure, failures: [frozenFailure] });
        } finally {
            await opened.database.close(opened.ctx);
        }

        const primitiveFailure = "primitive callback failure";
        const second = await openSessionDatabase(createTestRootContext(), ":memory:");
        try {
            const transaction = runSessionTransaction(second.ctx, async () => {
                await deferSessionTransactionCommit(() => {
                    throw primitiveFailure;
                });
            });
            const error = await transaction.catch((caught: unknown) => caught);
            expect(isSessionTransactionPostCommitError(error)).toBe(true);
            expect(error).toMatchObject({ cause: primitiveFailure, failures: [primitiveFailure] });
        } finally {
            await second.database.close(second.ctx);
        }
    });

    it("isolates nested transaction scopes and callbacks by database", async () => {
        const first = await openSessionDatabase(createTestRootContext(), ":memory:");
        const second = await openSessionDatabase(createTestRootContext(), ":memory:");
        try {
            let detachedScope: unknown;
            let releaseDetached!: () => void;
            const detachedGate = new Promise<void>((resolve) => {
                releaseDetached = resolve;
            });
            let detachedDone!: () => void;
            const detachedCompletion = new Promise<void>((resolve) => {
                detachedDone = resolve;
            });
            let detachedTask!: Promise<void>;

            await runSessionTransaction(first.ctx, async (firstCtx) => {
                const firstTx = firstCtx.tx;
                expect(sessionTransactionScope(first.database)).toBe(firstTx);
                expect(sessionTransactionScope(second.database)).toBe(second.database);

                let foreignCallbackRan = false;
                await deferSessionTransactionCommit(() => {
                    foreignCallbackRan = true;
                    expect(sessionTransactionScope(first.database)).toBe(first.database);
                    expect(sessionTransactionScope(second.database)).toBe(second.database);
                }, second.database);
                expect(foreignCallbackRan).toBe(true);

                detachedTask = (async () => {
                    await detachedGate;
                    detachedScope = sessionTransactionScope(first.database);
                    detachedDone();
                })();

                await runSessionTransaction(second.ctx, async (secondCtx) => {
                    const secondTx = secondCtx.tx;
                    expect(secondTx).not.toBe(firstTx);
                    expect(sessionTransactionScope(second.database)).toBe(secondTx);
                    expect(sessionTransactionScope(first.database)).toBe(first.database);
                });

                expect(sessionTransactionScope(first.database)).toBe(firstTx);
                expect(sessionTransactionScope(second.database)).toBe(second.database);
            });

            releaseDetached();
            await detachedTask;
            await detachedCompletion;
            expect(detachedScope).toBe(first.database);
        } finally {
            await first.database.close(first.ctx);
            await second.database.close(second.ctx);
        }
    });
});
