import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    UserInputModule,
    userInputMigrations,
    type UserInputEvent,
    type UserInputRequest,
} from "../../sources/userInput/index.js";
import { requestUserInputTool } from "../../sources/userInput/tools/request_user_input.js";
import { UserInputTestStore } from "./UserInputTestStore.js";

const ctx = createRootContext().named("user-input-tests");
const agentId = "agent-one";
const askInput = {
    question: "Which option should I use?",
    context: "The choice changes the implementation.",
} as const;

function createModule(
    store: UserInputTestStore,
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
        store,
        broker: store,
        idFactory: () => `request-${String(++requestIndex)}`,
        eventIdFactory: () => `event-${String(++eventIndex)}`,
        clock: () => ++now,
        ...options,
    });
}

function answered(request: UserInputRequest, answer = "Use the first option."): UserInputRequest {
    if (request.status !== "pending") throw new Error("expected pending request");
    return {
        ...request,
        status: "answered",
        answer,
        answeredAt: request.updatedAt + 1,
        updatedAt: request.updatedAt + 1,
    };
}

describe("UserInputModule", () => {
    it("creates and resumes the same request ID without module-owned replay records", async () => {
        const store = new UserInputTestStore();
        const module = createModule(store);

        const created = await module.ask(ctx, agentId, askInput, "stable-request");
        const resumed = await module.ask(ctx, agentId, askInput, "stable-request");

        expect(created.id).toBe("stable-request");
        expect(resumed).toEqual(created);
        expect(store.requests.size).toBe(1);
        expect(store.transactionCount).toBe(2);
        await expect(
            module.ask(
                ctx,
                agentId,
                { ...askInput, question: "A different question" },
                "stable-request",
            ),
        ).rejects.toThrow("different input");
    });

    it("uses the stable tool-call ID, waits outside transactions, and commits with settlement", async () => {
        const store = new UserInputTestStore();
        const module = createModule(store);
        const tool = requestUserInputTool(module, agentId);
        const commitStates: boolean[] = [];
        const commit = vi.fn(async (_ctx: Context, request: UserInputRequest) => {
            commitStates.push(store.insideTransaction);
            return request;
        });
        const call = {
            id: "cuid2-tool-call",
            providerCallId: "provider-call",
            kv: {} as never,
            commit,
        };

        const running = tool.execute(ctx, askInput, call);
        await vi.waitFor(() => expect(store.calls).toContain("wait"));
        const pending = store.requests.get(call.id);
        expect(pending?.status).toBe("pending");
        store.settle(answered(pending!));

        const result = await running;
        expect(result).toMatchObject({ id: call.id, status: "answered" });
        expect(store.transactionCount).toBe(2);
        expect(store.waitCalledInsideTransaction).toBe(false);
        expect(commit).toHaveBeenCalledOnce();
        expect(commitStates).toEqual([true]);
    });

    it("resumes a settled tool request and commits it in one transaction without waiting", async () => {
        const store = new UserInputTestStore();
        const module = createModule(store);
        const settled = answered(await module.ask(ctx, agentId, askInput, "resumed-call"));
        store.settle(settled);
        const beforeTransactions = store.transactionCount;
        const beforeWaits = store.calls.filter((call) => call === "wait").length;
        const tool = requestUserInputTool(module, agentId);
        const commit = vi.fn(async (_ctx: Context, request: UserInputRequest) => request);

        const result = await tool.execute(ctx, askInput, {
            id: "resumed-call",
            providerCallId: "provider-call",
            kv: {} as never,
            commit,
        });

        expect(result).toEqual(settled);
        expect(store.transactionCount).toBe(beforeTransactions + 1);
        expect(store.calls.filter((call) => call === "wait")).toHaveLength(beforeWaits);
        expect(commit).toHaveBeenCalledOnce();
    });

    it("settles answer, cancellation, and completion with one transaction each", async () => {
        const store = new UserInputTestStore();
        const module = createModule(store);
        const first = await module.ask(ctx, agentId, askInput, "answer-request");
        const second = await module.ask(ctx, agentId, askInput, "cancel-request");
        const third = await module.ask(ctx, agentId, askInput, "away-request");
        const before = store.transactionCount;

        expect(
            await module.answer(ctx, agentId, {
                requestId: first.id,
                answer: "Proceed.",
            }),
        ).toMatchObject({ status: "answered" });
        expect(
            await module.cancel(ctx, agentId, {
                requestId: second.id,
                reason: "No longer needed.",
            }),
        ).toMatchObject({ status: "cancelled" });
        expect(
            await module.complete(ctx, agentId, {
                requestId: third.id,
                outcome: "away",
            }),
        ).toMatchObject({ status: "away" });

        expect(store.transactionCount).toBe(before + 3);
    });

    it("settles an unavailable tool request and commits in its second transaction", async () => {
        const store = new UserInputTestStore();
        const module = createModule(store, { presence: { isAvailable: () => false } });
        const tool = requestUserInputTool(module, agentId);
        const commit = vi.fn(async (_ctx: Context, request: UserInputRequest) => request);

        const result = await tool.execute(ctx, askInput, {
            id: "away-call",
            providerCallId: "provider-call",
            kv: {} as never,
            commit,
        });

        expect(result).toMatchObject({ id: "away-call", status: "away" });
        expect(store.transactionCount).toBe(2);
        expect(store.calls).not.toContain("wait");
        expect(commit).toHaveBeenCalledOnce();
    });

    it("publishes transactional and post-commit events around the same transaction", async () => {
        const store = new UserInputTestStore();
        const order: string[] = [];
        const module = createModule(store, {
            listener: {
                onEventTransactional: async () => {
                    order.push(store.insideTransaction ? "transactional" : "wrong");
                },
                onEvent: async () => {
                    order.push(store.insideTransaction ? "wrong" : "post-commit");
                },
            },
        });

        await module.ask(ctx, agentId, askInput, "event-request");

        expect(order).toEqual(["transactional", "post-commit"]);
    });

    it("keeps cross-agent access denied unless explicitly authorized", async () => {
        const store = new UserInputTestStore();
        const module = createModule(store);
        const request = await module.ask(ctx, agentId, askInput, "private-request");

        await expect(module.get(ctx, "other-agent", request.id)).rejects.toThrow("not authorized");
    });

    it("adds a forward migration that drops the obsolete replay tables", () => {
        expect(userInputMigrations.map(([id]) => id)).toEqual([
            "001-user-input",
            "002-drop-user-input-idempotency",
        ]);
    });
});