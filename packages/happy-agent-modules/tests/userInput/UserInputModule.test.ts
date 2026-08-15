import { type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    UserInputModule,
    userInputMigrations,
    type UserInputEvent,
    type UserInputTerminalRequest,
} from "../../sources/userInput/index.js";
import { requestUserInputTool } from "../../sources/userInput/tools/request_user_input.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const agentId = "agent-one";
const askInput = {
    question: "Which option should I use?",
    context: "The choice changes the implementation.",
} as const;

class TestBroker {
    readonly calls: string[] = [];
    #waiters = new Map<string, (request: UserInputTerminalRequest) => void>();

    async wait(
        _ctx: Context,
        _agentId: string,
        requestId: string,
    ): Promise<UserInputTerminalRequest> {
        this.calls.push("wait");
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
        readonly presence?: { readonly isAvailable: () => boolean | Promise<boolean> };
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

    it("uses call.id, does not commit manually, and waits outside its transaction", async () => {
        const database = moduleDatabase(userInputMigrations, "user-input-tool-wait");
        await database.ready;
        try {
            const broker = new TestBroker();
            const module = createModule(broker);
            const tool = requestUserInputTool(module, agentId);
            expect(tool.durable).toBe(false);
            expect(tool.transactional).toBeUndefined();
            const running = tool.execute(database.context, askInput, {
                id: "tool-call",
                providerCallId: "provider-call",
            } as never);

            await vi.waitFor(() => expect(broker.calls).toEqual(["wait"]));
            const settled = await module.answer(database.context, agentId, {
                requestId: "tool-call",
                answer: "Use the first option.",
            });
            if (settled.status !== "answered") throw new Error("expected an answer");
            broker.settle(settled);

            await expect(running).resolves.toMatchObject({ id: "tool-call", status: "answered" });
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
                tool.execute(database.context, askInput, {
                    id: "away-call",
                    providerCallId: "provider-call",
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
            const request = await module.ask(database.context, agentId, askInput, "private-request");
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
});