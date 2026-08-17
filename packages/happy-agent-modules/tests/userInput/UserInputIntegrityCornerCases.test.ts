import { agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    UserInputModule,
    assertUserInputRequest,
    formatDetailPageForModel,
    type UserInputRequest,
    type UserInputTerminalRequest,
} from "../../sources/userInput/index.js";
import {
    createUserInputDatabase,
    createUserInputModule,
    onlinePresence,
    singularAsk,
} from "./userInputTestSupport.js";

const agentId = "agent-one";

describe("UserInput persistence and boundary integrity", () => {
    it.fails("rejects a row whose denormalized agent column disagrees with its JSON", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-column-integrity");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "column-integrity",
            );
            await agentDatabaseRun(
                database.context.db,
                sql`UPDATE happy_user_input_requests
                    SET asking_agent_id = 'other-agent'
                    WHERE id = ${request.id}`,
            );
            await expect(module.get(database.context, agentId, request.id)).rejects.toThrow(
                "agent",
            );
        } finally {
            database.close();
        }
    });

    it.fails("rejects an answered batch whose primary answer disagrees with its answer map", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-batch-answer-integrity");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                {
                    context: "Two related choices.",
                    questions: [
                        {
                            id: "scope",
                            question: "Scope?",
                            options: [{ label: "Small", description: "Safer" }],
                        },
                        {
                            id: "rollout",
                            question: "Rollout?",
                            options: [{ label: "Now", description: "Fast" }],
                        },
                    ],
                },
                "batch-answer-integrity",
            );
            const malformed: UserInputRequest = {
                ...request,
                status: "answered",
                answer: "Wrong primary answer",
                answers: {
                    scope: "Small",
                    rollout: "Now",
                },
                answeredAt: request.createdAt + 1,
                updatedAt: request.createdAt + 1,
            } as UserInputRequest;
            await agentDatabaseRun(
                database.context.db,
                sql`UPDATE happy_user_input_requests
                    SET status = 'answered',
                        updated_at = ${malformed.updatedAt},
                        request_json = ${JSON.stringify(malformed)}
                    WHERE id = ${request.id}`,
            );
            await expect(module.get(database.context, agentId, request.id)).rejects.toThrow(
                "primary answer",
            );
        } finally {
            database.close();
        }
    });

    it.fails("passes the transaction-derived context to clocks during settlement", async () => {
        const seen: Context[] = [];
        const module = new UserInputModule({
            idFactory: () => "clock-context",
            eventIdFactory: () => "clock-event",
            clock: (ctx) => {
                seen.push(ctx);
                return 100;
            },
        });
        const database = createUserInputDatabase(module, "user-input-clock-context");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "clock-context",
            );
            const afterAsk = seen.length;
            await module.answer(database.context, agentId, {
                requestId: request.id,
                answer: "The answer.",
            });
            expect(seen.slice(afterAsk).every((ctx) => ctx.db !== database.context.db)).toBe(true);
        } finally {
            database.close();
        }
    });

    it("settles away on a synchronous presence-away subscription callback", async () => {
        const module = createUserInputModule({
            presence: {
                state: () => onlinePresence(),
                subscribe: (ctx, _agentId, callback) => {
                    void callback(ctx, {
                        answerWaitMs: 0,
                        title: "Away",
                        emoji: "🌙",
                        prompt: "Continue independently.",
                    });
                },
            },
        });
        const database = createUserInputDatabase(module, "user-input-sync-presence");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "sync-presence",
            );
            await expect(module.wait(database.context, agentId, request.id)).resolves.toMatchObject(
                { status: "away" },
            );
        } finally {
            database.close();
        }
    });

    it.fails("keeps a detail-page continuation cursor visible within the model output budget", () => {
        const request: UserInputRequest = {
            id: "detail-request",
            askingAgentId: agentId,
            question: "Question",
            context: "Context",
            status: "pending",
            createdAt: 1,
            updatedAt: 1,
        };
        const output = formatDetailPageForModel(
            {
                request,
                detail: "D".repeat(2_000),
                cursor: 0,
                detailTotal: 2_000,
                nextCursor: "1",
            },
            256,
        );
        expect(output).toContain("Next cursor: 1");
    });

    it.fails("rejects a request whose valid per-field inputs exceed the total detail bound", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-detail-total-bound");
        await database.ready;
        try {
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    {
                        context: "C".repeat(100_000),
                        questions: Array.from({ length: 4 }, (_, index) => ({
                            id: `question-${String(index)}`,
                            question: `Question ${String(index)}`,
                            options: Array.from({ length: 13 }, (_, choice) => ({
                                label: `Choice ${String(choice)}`,
                                description: "D".repeat(2_000),
                            })),
                        })),
                    },
                    "detail-total-bound",
                ),
            ).rejects.toThrow("detail");
        } finally {
            database.close();
        }
    });

    it("rejects invalid event IDs before committing a request", async () => {
        const module = new UserInputModule({
            idFactory: () => "invalid-event-id-request",
            eventIdFactory: () => "",
            clock: () => 100,
        });
        const database = createUserInputDatabase(module, "user-input-invalid-event-id");
        await database.ready;
        try {
            await expect(
                module.ask(database.context, agentId, singularAsk(), "invalid-event-id-request"),
            ).rejects.toThrow("event identity");
            await expect(
                module.get(database.context, agentId, "invalid-event-id-request"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("rejects non-boolean authorization results without exposing the request", async () => {
        const module = createUserInputModule({
            authorization: {
                authorize: () => "yes" as never,
            },
        });
        const database = createUserInputDatabase(module, "user-input-auth-result");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                singularAsk(),
                "auth-result",
            );
            await expect(module.get(database.context, "other-agent", request.id)).rejects.toThrow(
                "non-boolean",
            );
        } finally {
            database.close();
        }
    });

    it("keeps direct event payload assertions strict about unknown keys", () => {
        expect(() =>
            assertUserInputRequest({
                id: "bad",
                askingAgentId: agentId,
                question: "Question",
                context: "Context",
                status: "pending",
                createdAt: 1,
                updatedAt: 1,
                unknown: true,
            } as never),
        ).toThrow("invalid");
    });
});
