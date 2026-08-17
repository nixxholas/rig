import { type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    UserInputModule,
    formatUserInputForModel,
    userInputMigrations,
    type UserInputEvent,
    type UserInputPresenceState,
    type UserInputTerminalRequest,
} from "../../sources/userInput/index.js";
import { cancelAskTool } from "../../sources/userInput/tools/cancel_ask.js";
import { requestUserInputTool } from "../../sources/userInput/tools/request_user_input.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const agentId = "agent-one";
const askInput = {
    question: "Which option should I use?",
    context: "The choice changes the implementation.",
} as const;

class TestBroker {
    readonly calls: string[] = [];
    readonly options: Array<{ readonly timeoutAt?: number }> = [];
    #waiters = new Map<string, (request: UserInputTerminalRequest) => void>();

    async wait(
        _ctx: Context,
        _agentId: string,
        requestId: string,
        options?: { readonly timeoutAt?: number },
    ): Promise<UserInputTerminalRequest> {
        this.calls.push("wait");
        this.options.push(options ?? {});
        return await new Promise((resolve) => this.#waiters.set(requestId, resolve));
    }

    settle(request: UserInputTerminalRequest): void {
        const resolve = this.#waiters.get(request.id);
        this.#waiters.delete(request.id);
        resolve?.(structuredClone(request));
    }
}

function createModule(
    broker: TestBroker,
    options: {
        readonly listener?: {
            readonly onEventTransactional?: (ctx: Context, event: UserInputEvent) => Promise<void>;
            readonly onEvent?: (ctx: Context, event: UserInputEvent) => Promise<void>;
        };
        readonly presence?: {
            readonly isAvailable?: () => boolean | Promise<boolean>;
            readonly state?: () =>
                | UserInputPresenceState
                | undefined
                | Promise<UserInputPresenceState | undefined>;
            readonly subscribe?: (
                ctx: Context,
                agentId: string,
                callback: (ctx: Context, state: UserInputPresenceState | undefined) => void,
            ) => void | (() => void);
        };
    } = {},
): UserInputModule {
    let requestIndex = 0;
    let eventIndex = 0;
    let now = 100;
    return new UserInputModule({
        broker,
        idFactory: () => `request-${String(++requestIndex)}`,
        eventIdFactory: () => `event-${String(++eventIndex)}`,
        clock: () => ++now,
        ...options,
    });
}

describe("UserInputModule", () => {
    it("uses ctx.db to create and resume the stable request identity", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-resume");
        await database.ready;
        try {
            const module = createModule(new TestBroker());
            const created = await module.ask(database.context, agentId, askInput, "stable-request");
            const resumed = await module.ask(database.context, agentId, askInput, "stable-request");

            expect(created.id).toBe("stable-request");
            expect(resumed).toEqual(created);
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    { ...askInput, question: "A different question" },
                    "stable-request",
                ),
            ).rejects.toThrow("different input");
        } finally {
            database.close();
        }
    });

    it("uses the provider call ID, does not commit manually, and waits outside its transaction", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-tool-wait");
        await database.ready;
        try {
            const broker = new TestBroker();
            const module = createModule(broker);
            const tool = requestUserInputTool(module, agentId);
            expect(tool.durable).toBe(false);
            expect(tool.transactional).toBeUndefined();
            const running = tool.execute(database.context, { input: askInput }, {
                id: "tool-call",
                providerCallId: "provider-call",
            } as never);

            await vi.waitFor(() => expect(broker.calls).toEqual(["wait"]));
            const settled = await module.answer(database.context, agentId, {
                requestId: "provider-call",
                answer: "Use the first option.",
            });
            if (settled.status !== "answered") throw new Error("expected an answer");
            broker.settle(settled);

            await expect(running).resolves.toMatchObject({
                id: "provider-call",
                status: "answered",
            });
        } finally {
            database.close();
        }
    });

    it("settles unavailable tool requests in a narrow second transaction", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-away");
        await database.ready;
        try {
            const broker = new TestBroker();
            const module = createModule(broker, { presence: { isAvailable: () => false } });
            const tool = requestUserInputTool(module, agentId);

            await expect(
                tool.execute(database.context, { input: askInput }, {
                    id: "internal-away-call",
                    providerCallId: "away-call",
                } as never),
            ).resolves.toMatchObject({ id: "away-call", status: "away" });
            expect(broker.calls).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("publishes transactional and post-commit events around the mutation", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-events");
        await database.ready;
        try {
            const order: string[] = [];
            const module = createModule(new TestBroker(), {
                listener: {
                    onEventTransactional: async (ctx) => {
                        order.push(ctx.db === database.database ? "wrong" : "transactional");
                    },
                    onEvent: async () => {
                        order.push("post-commit");
                    },
                },
            });

            await module.ask(database.context, agentId, askInput, "event-request");
            await vi.waitFor(() => expect(order).toEqual(["transactional", "post-commit"]));
        } finally {
            database.close();
        }
    });

    it("keeps cross-agent access denied unless explicitly authorized", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-auth");
        await database.ready;
        try {
            const module = createModule(new TestBroker());
            const request = await module.ask(
                database.context,
                agentId,
                askInput,
                "private-request",
            );
            await expect(module.get(database.context, "other-agent", request.id)).rejects.toThrow(
                "not authorized",
            );
        } finally {
            database.close();
        }
    });

    it("keeps the forward migration that drops obsolete replay tables", () => {
        expect(userInputMigrations.map(([id]) => id)).toEqual([
            "001-user-input",
            "002-drop-user-input-idempotency",
        ]);
    });

    it("exposes cancel_ask and withdraws a pending request", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-cancel-tool");
        await database.ready;
        try {
            const module = createModule(new TestBroker());
            const hooks = await resolveModuleHooks(database.context, module);
            const tools = await hooks.tools!(database.context, {
                agent: { id: agentId },
            } as never);
            expect(tools.map((tool) => tool.name)).toEqual(["request_user_input", "cancel_ask"]);
            const request = await module.ask(database.context, agentId, askInput, "cancel-call");
            const result = await cancelAskTool(module, agentId).execute(
                database.context,
                { input: { requestId: request.id } },
                {} as never,
            );
            expect(result).toMatchObject({ id: request.id, status: "cancelled" });
        } finally {
            database.close();
        }
    });

    it("stores and settles a related batch of questions as one Inbox request", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-batch");
        await database.ready;
        try {
            const broker = new TestBroker();
            const module = createModule(broker);
            const waiting = requestUserInputTool(module, agentId).execute(
                database.context,
                {
                    input: {
                        context: "Choose the scope and rollout.",
                        questions: [
                            {
                                id: "scope",
                                header: "Scope",
                                question: "Which scope should I use?",
                                options: [
                                    { label: "Small", description: "Safer first step." },
                                    { label: "Wide", description: "Faster broad rollout." },
                                ],
                                multiSelect: false,
                            },
                            {
                                id: "rollout",
                                header: "Rollout",
                                question: "Should rollout be gradual?",
                                options: {
                                    choices: [
                                        { label: "Yes", description: "Reduce deployment risk." },
                                        { label: "No", description: "Finish sooner." },
                                    ],
                                    multiSelect: false,
                                },
                            },
                        ],
                    },
                },
                { id: "internal-batch-call", providerCallId: "batch-call" } as never,
            );
            await vi.waitFor(() => expect(broker.calls).toEqual(["wait"]));
            const request = await module.get(database.context, agentId, "batch-call");
            if (request === undefined) throw new Error("expected batch request");
            expect(request.questions?.map((question) => question.header)).toEqual([
                "Scope",
                "Rollout",
            ]);
            const answered = await module.answer(database.context, agentId, {
                requestId: request.id,
                answers: {
                    scope: "Small",
                    rollout: "Yes",
                },
            });
            broker.settle(answered as UserInputTerminalRequest);
            await expect(waiting).resolves.toMatchObject({
                id: "batch-call",
                status: "answered",
                answers: { scope: "Small", rollout: "Yes" },
            });
        } finally {
            database.close();
        }
    });

    it("passes the auto-resolution deadline to the external wait broker", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-auto-resolution");
        await database.ready;
        try {
            const broker = new TestBroker();
            const module = createModule(broker);
            const waiting = requestUserInputTool(module, agentId).execute(
                database.context,
                {
                    input: {
                        question: "Should I continue?",
                        context: "This is useful but not blocking.",
                        header: "Continue",
                        autoResolutionMs: 60_000,
                    },
                },
                { id: "internal-auto-call", providerCallId: "auto-call" } as never,
            );
            await vi.waitFor(() => expect(broker.options[0]?.timeoutAt).toBe(60_101));
            const answered = await module.answer(database.context, agentId, {
                requestId: "auto-call",
                answer: "Yes",
            });
            broker.settle(answered as UserInputTerminalRequest);
            await expect(waiting).resolves.toMatchObject({ status: "answered" });
        } finally {
            database.close();
        }
    });

    it("re-evaluates a live presence change while the broker wait is in flight", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-presence-change");
        await database.ready;
        try {
            let current: UserInputPresenceState = {
                answerWaitMs: null,
                title: "Online",
                emoji: "🟢",
                prompt: "You can reach the user now.",
            };
            const listeners = new Set<
                (ctx: Context, state: UserInputPresenceState | undefined) => void
            >();
            const broker = new TestBroker();
            const module = createModule(broker, {
                presence: {
                    state: () => current,
                    subscribe: (_ctx, _agentId, callback) => {
                        listeners.add(callback);
                        return () => listeners.delete(callback);
                    },
                },
            });
            const request = await module.ask(database.context, agentId, askInput, "presence-call");
            const waiting = module.wait(database.context, agentId, request.id);
            await vi.waitFor(() => expect(broker.calls).toEqual(["wait"]));
            current = {
                answerWaitMs: 0,
                title: "Away",
                emoji: "🌙",
                prompt: "Do not wait for an answer; keep working.",
                changesAt: 200,
            };
            for (const listener of listeners) listener(database.context, current);
            const result = await waiting;
            expect(result.status).toBe("away");
            const text = formatUserInputForModel(result);
            expect(text).toContain("Away 🌙");
            expect(text).toContain("Do not wait for an answer");
            expect(text).toContain("cancel_ask");
            expect(text).toContain("best judgement");
        } finally {
            database.close();
        }
    });
});
