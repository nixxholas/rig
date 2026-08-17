import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { UserInputModule, type UserInputPresenceState } from "../../sources/userInput/index.js";
import {
    createUserInputDatabase,
    createUserInputModule,
    onlinePresence,
    singularAsk,
} from "./userInputTestSupport.js";

const agentId = "agent-one";

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
    it("wakes a parked wait with the outcome a direct answer committed", async () => {
        const module = createUserInputModule();
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
            // Answering on the same database is only possible because the wait holds no
            // transaction open, and nothing but this call is needed to end the wait.
            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Use the first option.",
            });
            await expect(waiting).resolves.toEqual(answered);
        } finally {
            database.close();
        }
    });

    it("returns the committed outcome to a wait that starts after the answer", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-wait-after-answer");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "late-wait");
            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Answered before anyone waited.",
            });
            await expect(module.wait(database.context, agentId, request.id)).resolves.toEqual(
                answered,
            );
        } finally {
            database.close();
        }
    });

    it("cleans up presence subscriptions when a wait ends with an error", async () => {
        let callback:
            | ((ctx: Context, state: UserInputPresenceState | undefined) => void)
            | undefined;
        let unsubscribed = 0;
        const module = createUserInputModule({
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
        const database = createUserInputDatabase(module, "user-input-wait-rejection");
        await database.ready;
        try {
            const request = await module.ask(database.context, agentId, singularAsk(), "rejected");
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(callback).toBeDefined());
            await callback?.(database.context, {
                answerWaitMs: -1,
                title: "Bad",
                emoji: "!",
                prompt: "",
            } as never);
            await expect(waiting).rejects.toThrow("presence state");
            expect(unsubscribed).toBe(1);
        } finally {
            database.close();
        }
    });

    it("settles immediate away and expired deadline outcomes without parking a wait", async () => {
        let now = 100;
        const awayModule = new UserInputModule({
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
        } finally {
            awayDatabase.close();
        }

        const deadlineModule = new UserInputModule({
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
        const module = createUserInputModule({
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
            await vi.waitFor(() => expect(callback).toBeDefined());
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
        const module = new UserInputModule({
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
        const invalidCleanupModule = createUserInputModule({
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

        let malformedCallback:
            | ((ctx: Context, state: UserInputPresenceState | undefined) => void)
            | undefined;
        const malformedModule = createUserInputModule({
            presence: {
                state: () => onlinePresence(),
                subscribe: (_ctx, _agentId, next) => {
                    malformedCallback = next;
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
            await vi.waitFor(() => expect(malformedCallback).toBeDefined());
            await malformedCallback?.(malformedDatabase.context, {
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
        const module = createUserInputModule();
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
        const module = createUserInputModule();
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
});
