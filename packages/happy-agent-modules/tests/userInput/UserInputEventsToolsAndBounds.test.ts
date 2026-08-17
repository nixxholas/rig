import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    UserInputModule,
    cancelAskTool,
    formatDetailPageForModel,
    formatForModel,
    formatPageForModel,
    requestUserInputTool,
    type UserInputEvent,
    type UserInputTerminalRequest,
} from "../../sources/userInput/index.js";
import {
    createUserInputDatabase,
    createUserInputModule,
    singularAsk,
} from "./userInputTestSupport.js";

const agentId = "agent-one";

describe("UserInput events, tools, and output bounds", () => {
    it("delivers one stable deeply frozen event through outer afterCommit", async () => {
        let transactional: UserInputEvent | undefined;
        let postCommit: UserInputEvent | undefined;
        const module = createUserInputModule({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional = event;
                    expect(Object.isFrozen(event)).toBe(true);
                    expect(Object.isFrozen(event.request)).toBe(true);
                    if (event.request.options !== undefined) {
                        expect(Object.isFrozen(event.request.options)).toBe(true);
                        expect(Object.isFrozen(event.request.options.choices)).toBe(true);
                        expect(Object.isFrozen(event.request.options.choices[0])).toBe(true);
                    }
                },
                onEvent: (_ctx, event) => {
                    postCommit = event;
                },
            },
        });
        const database = createUserInputDatabase(module, "user-input-event-freeze");
        await database.ready;
        try {
            await database.context.inTx(async (outer) => {
                await module.ask(
                    outer,
                    agentId,
                    singularAsk({
                        options: {
                            choices: [{ label: "A", description: "First" }],
                            multiSelect: false,
                        },
                    }),
                    "event-request",
                );
                expect(transactional).toBeDefined();
                expect(postCommit).toBeUndefined();
            });
            expect(postCommit).toBe(transactional);
            expect(postCommit).toMatchObject({
                type: "user_input_requested",
                eventId: "event-1",
                requestId: "event-request",
            });
            expect(() => {
                if (transactional?.type === "user_input_requested") {
                    transactional.request.context = "mutated";
                }
            }).toThrow();
        } finally {
            database.close();
        }
    });

    it("publishes no post-commit event or durable row after outer rollback", async () => {
        const transactional: string[] = [];
        const postCommit: string[] = [];
        const module = createUserInputModule({
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event.type);
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event.type);
                },
            },
        });
        const database = createUserInputDatabase(module, "user-input-event-rollback");
        await database.ready;
        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await module.ask(txCtx, agentId, singularAsk(), "rolled-back");
                    throw new Error("outer rollback");
                }),
            ).rejects.toThrow("outer rollback");
            expect(transactional).toEqual(["user_input_requested"]);
            expect(postCommit).toEqual([]);
            await expect(
                module.get(database.context, agentId, "rolled-back"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rolls back durable state when a transactional listener fails", async () => {
        const module = createUserInputModule({
            listener: {
                onEventTransactional: () => {
                    throw new Error("transactional listener failed");
                },
            },
        });
        const database = createUserInputDatabase(module, "user-input-event-listener-rollback");
        await database.ready;
        try {
            await expect(
                module.ask(database.context, agentId, singularAsk(), "listener-rollback"),
            ).rejects.toThrow("transactional listener failed");
            await expect(
                module.get(database.context, agentId, "listener-rollback"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains post-commit listener failures and tolerates a failing error reporter", async () => {
        const reports: unknown[] = [];
        const hostile = {
            get message(): never {
                throw new Error("message getter failed");
            },
            [Symbol.toPrimitive](): never {
                throw new Error("primitive conversion failed");
            },
        };
        const module = createUserInputModule({
            listener: {
                onEvent: () => {
                    throw hostile;
                },
            },
            onPostCommitError: (_ctx, event, error) => {
                reports.push({ eventId: event.eventId, error });
                throw new Error("reporter failed");
            },
        });
        const database = createUserInputDatabase(module, "user-input-post-commit-error");
        await database.ready;
        try {
            await expect(
                module.ask(database.context, agentId, singularAsk(), "post-commit-error"),
            ).resolves.toMatchObject({ id: "post-commit-error" });
            await vi.waitFor(() => expect(reports).toHaveLength(1));
            expect(
                (reports[0] as { readonly eventId: string; readonly error: unknown }).eventId,
            ).toBe("event-1");
            expect(
                (reports[0] as { readonly eventId: string; readonly error: unknown }).error,
            ).toBe(hostile);
            await expect(
                module.get(database.context, agentId, "post-commit-error"),
            ).resolves.toMatchObject({ status: "pending" });
        } finally {
            database.close();
        }
    });

    it("preserves owning this for class-backed listener and authorization adapters", async () => {
        class Listener {
            readonly events: string[] = [];

            onEventTransactional(_ctx: Context, event: UserInputEvent): void {
                this.events.push(`tx:${event.type}`);
            }

            onEvent(_ctx: Context, event: UserInputEvent): void {
                this.events.push(`post:${event.type}`);
            }
        }
        class Authorization {
            readonly calls: string[] = [];

            authorize(
                _ctx: Context,
                actingAgentId: string,
                askingAgentId: string,
                action: string,
            ): boolean {
                this.calls.push(`${actingAgentId}:${askingAgentId}:${action}`);
                return true;
            }
        }
        const listener = new Listener();
        const authorization = new Authorization();
        const module = new UserInputModule({
            listener,
            authorization,
            idFactory: () => "class-request",
            eventIdFactory: () => "class-event",
            clock: () => 100,
        });
        const database = createUserInputDatabase(module, "user-input-class-adapters");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "class-request",
            );
            const waiting = module.wait(database.context, agentId, request.id);
            await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "Use it.",
            });
            await expect(waiting).resolves.toMatchObject({ status: "answered" });
            expect(listener.events).toEqual([
                "tx:user_input_requested",
                "post:user_input_requested",
                "tx:user_input_answered",
                "post:user_input_answered",
            ]);
            expect(authorization.calls).toEqual([]);
        } finally {
            database.close();
        }
    });

    it.fails("keeps model-facing output bounded while retaining request identity and continuation", () => {
        const module = createUserInputModule({
            maxOutputCharacters: 256,
        });
        const request = {
            id: "r".repeat(128),
            askingAgentId: agentId,
            question: "Q".repeat(200),
            context: "Context",
            status: "pending" as const,
            createdAt: 1,
            updatedAt: 1,
        };
        const requestOutput = formatForModel(request, 256);
        expect(requestOutput.length).toBeLessThanOrEqual(256);
        expect(requestOutput.startsWith(`Request ${request.id}:`)).toBe(true);

        const pageOutput = formatPageForModel(
            {
                requests: [request],
                cursor: "0",
                limit: 1,
                nextCursor: "1",
            },
            256,
        );
        expect(pageOutput.length).toBeLessThanOrEqual(256);
        expect(pageOutput).toContain(request.id);
        expect(pageOutput).toContain("Next cursor:");

        const detailOutput = formatDetailPageForModel(
            {
                request,
                detail: "D".repeat(2_000),
                cursor: 0,
                detailTotal: 2_000,
                nextCursor: "10",
            },
            256,
        );
        expect(detailOutput.length).toBeLessThanOrEqual(256);
        expect(detailOutput).toContain(`Request ${request.id}:`);
    });

    it("uses provider call IDs for request identity and supports detail reads through the same tool", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-tools");
        await database.ready;
        try {
            const requestTool = requestUserInputTool(module, agentId);
            const running = requestTool.execute(
                database.context,
                {
                    input: {
                        question: "What should I do?",
                        context: "A durable context.",
                    },
                },
                {
                    id: "internal-id",
                    providerCallId: "provider-call-id",
                } as never,
            );
            await vi.waitFor(async () => {
                expect(
                    await module.get(database.context, agentId, "provider-call-id"),
                ).toBeDefined();
            });
            await module.answer(database.context, agentId, {
                requestId: "provider-call-id",
                answer: "Proceed.",
            });
            await expect(running).resolves.toMatchObject({
                id: "provider-call-id",
                status: "answered",
            });

            const detail = await requestTool.execute(
                database.context,
                {
                    input: {
                        requestId: "provider-call-id",
                        cursor: "0",
                        limit: 64,
                    },
                },
                {} as never,
            );
            expect(detail).toMatchObject({
                request: { id: "provider-call-id", status: "answered" },
                cursor: 0,
            });
            expect(requestTool.toLLM(detail as never)[0]).toMatchObject({ type: "text" });

            const cancelTool = cancelAskTool(module, agentId);
            const pending = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "legacy-cancel",
            );
            await expect(
                cancelTool.execute(
                    database.context,
                    { input: { ask_id: pending.id } },
                    {} as never,
                ),
            ).resolves.toMatchObject({
                id: pending.id,
                status: "cancelled",
                reason: "The answer is no longer needed.",
            });
        } finally {
            database.close();
        }
    });

    it("rejects invalid injected IDs, clocks, and answer/output bounds before writing", async () => {
        const badId = new UserInputModule({
            idFactory: () => "",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        const badIdDatabase = createUserInputDatabase(badId, "user-input-bad-id");
        await badIdDatabase.ready;
        try {
            await expect(badId.ask(badIdDatabase.context, agentId, singularAsk())).rejects.toThrow(
                "identity",
            );
            await expect(
                badId.get(badIdDatabase.context, agentId, "request-1"),
            ).resolves.toBeUndefined();
        } finally {
            badIdDatabase.close();
        }

        const badClock = new UserInputModule({
            idFactory: () => "bad-clock",
            eventIdFactory: () => "event",
            clock: () => -1,
        } as never);
        const badClockDatabase = createUserInputDatabase(badClock, "user-input-bad-clock");
        await badClockDatabase.ready;
        try {
            await expect(
                badClock.ask(badClockDatabase.context, agentId, singularAsk()),
            ).rejects.toThrow("clock");
        } finally {
            badClockDatabase.close();
        }

        const bounded = createUserInputModule({
            maxAnswerCharacters: 4,
            maxCancelReasonCharacters: 4,
            maxContextCharacters: 4,
            maxQuestionCharacters: 4,
            maxOptionCount: 1,
            maxOptionLabelCharacters: 2,
            maxOptionDescriptionCharacters: 3,
        });
        const boundedDatabase = createUserInputDatabase(bounded, "user-input-bounds");
        await boundedDatabase.ready;
        try {
            await expect(
                bounded.ask(boundedDatabase.context, agentId, singularAsk()),
            ).rejects.toThrow("bound");
            const request = await bounded.ask(
                boundedDatabase.context,
                agentId,
                {
                    question: "Q",
                    context: "C",
                    options: {
                        choices: [{ label: "A", description: "One" }],
                        multiSelect: false,
                    },
                },
                "bounded-request",
            );
            await expect(
                bounded.answer(boundedDatabase.context, agentId, {
                    requestId: request.id,
                    answer: "Too long",
                }),
            ).rejects.toThrow("bound");
            await expect(
                bounded.cancel(boundedDatabase.context, agentId, {
                    requestId: request.id,
                    reason: "Too long",
                }),
            ).rejects.toThrow("bound");
        } finally {
            boundedDatabase.close();
        }
    });
});

function terminalAnswer(requestId: string): UserInputTerminalRequest {
    return {
        id: requestId,
        askingAgentId: agentId,
        question: "Which option should I use?",
        context: "The choice changes the implementation.",
        status: "answered",
        answer: "Use it.",
        answeredAt: 100,
        createdAt: 100,
        updatedAt: 100,
    };
}
