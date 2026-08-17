import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    UserInputModule,
    type UserInputPresenceState,
    type UserInputTerminalRequest,
} from "../../sources/userInput/index.js";
import {
    createUserInputDatabase,
    createUserInputModule,
    onlinePresence,
    singularAsk,
    UserInputTestBroker,
} from "./userInputTestSupport.js";

const agentId = "agent-one";

function terminalAnswer(
    requestId: string,
    overrides: Partial<UserInputTerminalRequest> = {},
): UserInputTerminalRequest {
    return {
        id: requestId,
        askingAgentId: agentId,
        question: "Which option should I use?",
        context: "The choice changes the implementation.",
        status: "answered",
        answer: "The first option.",
        answeredAt: 110,
        createdAt: 100,
        updatedAt: 110,
        ...overrides,
    } as UserInputTerminalRequest;
}

let serializedHostWork: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serializedHostWork.then(operation);
    serializedHostWork = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

describe("UserInput waits, presence, and concurrency", () => {
    it("passes a root context to the broker and never holds a transaction open during a wait", async () => {
        const broker = new UserInputTestBroker();
        const module = createUserInputModule(broker);
        const database = createUserInputDatabase(module, "user-input-wait-context");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "wait-context",
            );
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(broker.calls).toEqual([request.id]));
            expect(broker.contexts[0]?.db).toBe(database.context.db);

            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Use the first option.",
            });
            broker.settle(answered as UserInputTerminalRequest);
            await expect(waiting).resolves.toMatchObject({
                id: request.id,
                status: "answered",
            });
        } finally {
            database.close();
        }
    });

    it.fails("moves a broker wait outside an already-open caller transaction", async () => {
        let seenContext: Context | undefined;
        const broker = {
            async wait(ctx: Context): Promise<UserInputTerminalRequest> {
                seenContext = ctx;
                throw new Error("stop waiting");
            },
        };
        const module = new UserInputModule({
            broker,
            idFactory: () => "transaction-wait",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        const database = createUserInputDatabase(module, "user-input-wait-in-transaction");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "transaction-wait",
            );
            await database.context.inTx(async (txCtx) => {
                await expect(module.wait(txCtx, agentId, request.id)).rejects.toThrow(
                    "stop waiting",
                );
                expect(seenContext?.db).toBe(database.context.db);
            });
        } finally {
            database.close();
        }
    });

    it("rejects a broker result that is pending or disagrees with authoritative storage", async () => {
        const pendingBroker = {
            async wait(): Promise<unknown> {
                return {
                    id: "pending-result",
                    askingAgentId: agentId,
                    question: "Question",
                    context: "Context",
                    status: "pending",
                    createdAt: 100,
                    updatedAt: 100,
                };
            },
        };
        const pendingModule = new UserInputModule({
            broker: pendingBroker as never,
            idFactory: () => "pending-result",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        const pendingDatabase = createUserInputDatabase(pendingModule, "user-input-broker-pending");
        await pendingDatabase.ready;
        try {
            await pendingModule.ask(
                pendingDatabase.context,
                agentId,
                singularAsk(),
                "pending-result",
            );
            await expect(
                pendingModule.wait(pendingDatabase.context, agentId, "pending-result"),
            ).rejects.toThrow("pending request");
        } finally {
            pendingDatabase.close();
        }

        const staleBroker = new UserInputTestBroker();
        const staleModule = createUserInputModule(staleBroker);
        const staleDatabase = createUserInputDatabase(staleModule, "user-input-broker-stale");
        await staleDatabase.ready;
        try {
            const request = await staleModule.ask(
                staleDatabase.context,
                agentId,
                singularAsk(),
                "stale-result",
            );
            const waiting = staleModule.wait(staleDatabase.context, agentId, request.id);
            await vi.waitFor(() => expect(staleBroker.calls).toEqual([request.id]));
            staleBroker.settle(terminalAnswer(request.id));
            await expect(waiting).rejects.toThrow("authoritative storage");
            await expect(
                staleModule.get(staleDatabase.context, agentId, request.id),
            ).resolves.toMatchObject({ status: "pending" });
        } finally {
            staleDatabase.close();
        }
    });

    it("cleans up presence subscriptions when the external broker rejects", async () => {
        let callback:
            | ((ctx: Context, state: UserInputPresenceState | undefined) => void)
            | undefined;
        let unsubscribed = 0;
        const broker = new UserInputTestBroker();
        const module = createUserInputModule(broker, {
            presence: {
                state: () => onlinePresence(),
                subscribe: (_ctx, _agentId, next) => {
                    callback = next;
                    return () => {
                        unsubscribed += 1;
                    };
                },
            },
        });
        const database = createUserInputDatabase(module, "user-input-broker-rejection");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "rejected");
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(broker.calls).toEqual([request.id]));
            expect(callback).toBeDefined();
            broker.reject(request.id, new Error("broker disconnected"));
            await expect(waiting).rejects.toThrow("broker disconnected");
            expect(unsubscribed).toBe(1);
        } finally {
            database.close();
        }
    });

    it("settles immediate away and expired deadline outcomes without calling the broker", async () => {
        let now = 100;
        const awayBroker = new UserInputTestBroker();
        const awayModule = new UserInputModule({
            broker: awayBroker,
            idFactory: () => "away-request",
            eventIdFactory: () => "event-away",
            clock: () => now,
            presence: {
                state: () => ({
                    answerWaitMs: 0,
                    title: "Away",
                    emoji: "🌙",
                    prompt: "Continue independently.",
                }),
            },
        });
        const awayDatabase = createUserInputDatabase(awayModule, "user-input-immediate-away");
        await awayDatabase.ready;
        try {
            const request = await awayModule.ask(
                awayDatabase.context,
                agentId,
                singularAsk(),
                "away-request",
            );
            await expect(
                awayModule.wait(awayDatabase.context, agentId, request.id),
            ).resolves.toMatchObject({
                status: "away",
                presence: { title: "Away" },
                waitedMs: 0,
            });
            expect(awayBroker.calls).toEqual([]);
        } finally {
            awayDatabase.close();
        }

        const deadlineBroker = new UserInputTestBroker();
        const deadlineModule = new UserInputModule({
            broker: deadlineBroker,
            idFactory: () => "expired-request",
            eventIdFactory: () => "event-expired",
            clock: () => now,
        });
        const deadlineDatabase = createUserInputDatabase(
            deadlineModule,
            "user-input-immediate-deadline",
        );
        await deadlineDatabase.ready;
        try {
            const request = await deadlineModule.ask(
                deadlineDatabase.context,
                agentId,
                singularAsk({ deadlineAt: 150 }),
                "expired-request",
            );
            now = 200;
            await expect(
                deadlineModule.wait(deadlineDatabase.context, agentId, request.id),
            ).resolves.toMatchObject({
                status: "timed_out",
                deadlineAt: 150,
                timedOutAt: 200,
            });
            expect(deadlineBroker.calls).toEqual([]);
        } finally {
            deadlineDatabase.close();
        }
    });

    it("uses live presence changes to end an in-flight wait and removes the subscription", async () => {
        let current = onlinePresence();
        let callback:
            | ((ctx: Context, state: UserInputPresenceState | undefined) => void)
            | undefined;
        let unsubscribed = 0;
        const broker = new UserInputTestBroker();
        const module = createUserInputModule(broker, {
            presence: {
                state: () => current,
                subscribe: (_ctx, _agentId, next) => {
                    callback = next;
                    return () => {
                        unsubscribed += 1;
                    };
                },
            },
        });
        const database = createUserInputDatabase(module, "user-input-live-away");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "live-away");
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(broker.calls).toEqual([request.id]));
            current = onlinePresence({
                answerWaitMs: 0,
                title: "Away",
                emoji: "🌙",
                prompt: "Keep working without an answer.",
                changesAt: 200,
            });
            await callback?.(database.context, current);
            await expect(waiting).resolves.toMatchObject({
                status: "away",
                presence: current,
            });
            expect(unsubscribed).toBe(1);
        } finally {
            database.close();
        }
    });

    it.fails("times out at the earlier presence deadline when the request has a later explicit deadline", async () => {
        vi.useFakeTimers();
        let now = 100;
        const broker = new UserInputTestBroker();
        const module = new UserInputModule({
            broker,
            idFactory: () => "presence-deadline",
            eventIdFactory: () => "presence-event",
            clock: () => now,
            presence: {
                state: () => ({
                    answerWaitMs: 10,
                    title: "Busy",
                    emoji: "⏳",
                    prompt: "Continue if nobody answers soon.",
                }),
            },
        });
        const database = createUserInputDatabase(module, "user-input-presence-deadline");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk({ deadlineAt: 200 }),
                "presence-deadline",
            );
            const waiting = module.wait(database.context, agentId, request.id).then(
                (value) => ({ status: "resolved" as const, value }),
                (error: unknown) => ({ status: "rejected" as const, error }),
            );
            await vi.waitFor(() => expect(broker.calls).toEqual([request.id]));
            await vi.advanceTimersByTimeAsync(10);
            const result = await waiting;
            expect(result).toMatchObject({
                status: "resolved",
                value: {
                    status: "timed_out",
                    deadlineAt: 110,
                },
            });
        } finally {
            database.close();
            vi.useRealTimers();
        }
    });

    it("rejects malformed presence updates and invalid cleanup values", async () => {
        let callback:
            | ((ctx: Context, state: UserInputPresenceState | undefined) => void)
            | undefined;
        const invalidCleanupModule = createUserInputModule(new UserInputTestBroker(), {
            presence: {
                state: () => onlinePresence(),
                subscribe: (_ctx, _agentId, next) => {
                    callback = next;
                    return {} as never;
                },
            },
        });
        const invalidCleanupDatabase = createUserInputDatabase(
            invalidCleanupModule,
            "user-input-invalid-cleanup",
        );
        await invalidCleanupDatabase.ready;
        try {
            const request = await invalidCleanupModule.ask(
                invalidCleanupDatabase.context,
                agentId,
                singularAsk(),
                "invalid-cleanup",
            );
            await expect(
                invalidCleanupModule.wait(invalidCleanupDatabase.context, agentId, request.id),
            ).rejects.toThrow("invalid cleanup");
        } finally {
            invalidCleanupDatabase.close();
        }

        const broker = new UserInputTestBroker();
        const malformedModule = createUserInputModule(broker, {
            presence: {
                state: () => onlinePresence(),
                subscribe: (_ctx, _agentId, next) => {
                    callback = next;
                },
            },
        });
        const malformedDatabase = createUserInputDatabase(
            malformedModule,
            "user-input-invalid-presence",
        );
        await malformedDatabase.ready;
        try {
            const request = await malformedModule.ask(
                malformedDatabase.context,
                agentId,
                singularAsk(),
                "invalid-presence",
            );
            const waiting = malformedModule.wait(malformedDatabase.context, agentId, request.id);
            await vi.waitFor(() => expect(broker.calls).toEqual([request.id]));
            await callback?.(malformedDatabase.context, {
                answerWaitMs: -1,
                title: "Bad",
                emoji: "!",
                prompt: "",
            } as never);
            await expect(waiting).rejects.toThrow("presence state");
        } finally {
            malformedDatabase.close();
        }
    });

    it("serializes concurrent answer and cancellation mutations to one terminal result", async () => {
        const module = createUserInputModule(new UserInputTestBroker());
        const database = createUserInputDatabase(module, "user-input-concurrency");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "race");
            const outcomes = await Promise.all([
                enqueue(() =>
                    module.answer(database.context, agentId, {
                        requestId: request.id,
                        answer: "Answer wins.",
                    }),
                ),
                enqueue(() =>
                    module.cancel(database.context, agentId, {
                        requestId: request.id,
                        reason: "Cancel wins.",
                    }),
                ),
            ]);
            expect(outcomes.every((outcome) => outcome.status !== "pending")).toBe(true);
            expect(new Set(outcomes.map((outcome) => outcome.status)).size).toBe(1);
            await expect(module.get(database.context, agentId, request.id)).resolves.toEqual(
                outcomes[0],
            );
        } finally {
            database.close();
        }
    });

    it("keeps concurrent identical ask retries idempotent and rejects divergent input", async () => {
        const module = createUserInputModule(new UserInputTestBroker());
        const database = createUserInputDatabase(module, "user-input-ask-concurrency");
        await database.ready;
        try {
            const [first, second] = await Promise.all([
                enqueue(() => module.ask(database.context, agentId, singularAsk(), "same-id")),
                enqueue(() => module.ask(database.context, agentId, singularAsk(), "same-id")),
            ]);
            expect(first).toEqual(second);
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    singularAsk({ question: "Different question." }),
                    "same-id",
                ),
            ).rejects.toThrow("different input");
        } finally {
            database.close();
        }
    });

    it("allows an external broker to return a terminal answer only after durable storage agrees", async () => {
        const broker = new UserInputTestBroker();
        const module = createUserInputModule(broker);
        const database = createUserInputDatabase(module, "user-input-broker-answer");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "broker-answer",
            );
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(broker.calls).toEqual([request.id]));
            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "The answer.",
            });
            broker.settle(answered as UserInputTerminalRequest);
            await expect(waiting).resolves.toEqual(answered);
        } finally {
            database.close();
        }
    });
});
