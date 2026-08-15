import { createContextNamespace, withAfterCommit, type Context } from "@steve.kite/stdlib";

import {
    type UserInputListQuery,
    type UserInputPage,
    type UserInputRequest,
    type UserInputTerminalRequest,
} from "../../sources/userInput/UserInputRequest.js";
import {
    type UserInputBroker,
    type UserInputStore,
    type UserInputTransactionChange,
} from "../../sources/userInput/UserInputStore.js";

function clone<Value>(value: Value): Value {
    return structuredClone(value);
}

const transactionTokenNamespace = createContextNamespace<symbol | undefined>(
    "userInputTestStoreTransaction",
    undefined,
);

export class UserInputTestStore implements UserInputStore, UserInputBroker {
    readonly requests = new Map<string, UserInputRequest>();
    readonly calls: string[] = [];
    transactionCount = 0;
    waitCalledInsideTransaction = false;
    #transactionDepth = 0;
    #activeTransactionToken: symbol | undefined;
    #queue: Promise<void> = Promise.resolve();
    #pendingWaiterReleases = new Set<string>();
    #waiters = new Map<string, Array<(request: UserInputTerminalRequest) => void>>();

    async transaction(
        ctx: Context,
        _actingAgentId: string,
        work: (txCtx: Context) => Promise<UserInputTransactionChange>,
    ): Promise<UserInputTransactionChange> {
        const activeToken = transactionTokenNamespace.get(ctx);
        if (activeToken !== undefined && activeToken === this.#activeTransactionToken) {
            this.#transactionDepth += 1;
            try {
                return clone(await work(ctx));
            } finally {
                this.#transactionDepth -= 1;
            }
        }

        const run = this.#queue.then(async () => {
            this.transactionCount += 1;
            const snapshot = new Map(
                [...this.requests].map(([id, value]) => [id, clone(value)]),
            );
            this.#pendingWaiterReleases.clear();
            const transactionToken = Symbol("user-input-test-transaction");
            this.#activeTransactionToken = transactionToken;
            this.#transactionDepth = 1;
            const [commitCtx, runAfterCommit] = withAfterCommit(
                transactionTokenNamespace.set(ctx, transactionToken),
            );
            try {
                const result = clone(await work(commitCtx));
                const releaseIds = [...this.#pendingWaiterReleases];
                this.#pendingWaiterReleases.clear();
                this.#transactionDepth = 0;
                this.#activeTransactionToken = undefined;
                return { result, releaseIds, runAfterCommit };
            } catch (error: unknown) {
                this.#transactionDepth = 0;
                this.#activeTransactionToken = undefined;
                this.requests.clear();
                for (const [id, value] of snapshot) this.requests.set(id, clone(value));
                this.#pendingWaiterReleases.clear();
                throw error;
            }
        });
        this.#queue = run.then(
            () => undefined,
            () => undefined,
        );
        const committed = await run;
        await committed.runAfterCommit();
        this.#releaseWaiters(committed.releaseIds);
        return committed.result;
    }

    async readRequest(_ctx: Context, requestId: string): Promise<UserInputRequest | undefined> {
        this.calls.push("readRequest");
        const value = this.requests.get(requestId);
        return value === undefined ? undefined : clone(value);
    }

    async writeRequest(_ctx: Context, request: UserInputRequest): Promise<void> {
        this.calls.push("writeRequest");
        this.requests.set(request.id, clone(request));
        if (request.status !== "pending") this.#pendingWaiterReleases.add(request.id);
    }

    async listRequests(
        _ctx: Context,
        askingAgentId: string,
        query: UserInputListQuery,
    ): Promise<UserInputPage> {
        this.calls.push("listRequests");
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const limit = query.limit ?? 50;
        const rows = [...this.requests.values()]
            .filter((request) => request.askingAgentId === askingAgentId)
            .filter((request) => {
                if (query.status === "pending") return request.status === "pending";
                if (query.status === "terminal") return request.status !== "pending";
                return true;
            })
            .sort((left, right) => left.id.localeCompare(right.id));
        const requests = rows.slice(start, start + limit).map(clone);
        return {
            requests,
            cursor: String(start),
            limit,
            ...(start > 0 ? { previousCursor: String(Math.max(0, start - limit)) } : {}),
            ...(start + requests.length < rows.length
                ? { nextCursor: String(start + requests.length) }
                : {}),
        };
    }

    async wait(
        _ctx: Context,
        _actingAgentId: string,
        requestId: string,
    ): Promise<UserInputTerminalRequest> {
        this.calls.push("wait");
        if (this.#transactionDepth > 0) this.waitCalledInsideTransaction = true;
        const current = this.requests.get(requestId);
        if (current === undefined) throw new Error("missing request");
        if (current.status !== "pending") return clone(current);
        return await new Promise<UserInputTerminalRequest>((resolve) => {
            const waiters = this.#waiters.get(requestId) ?? [];
            waiters.push(resolve);
            this.#waiters.set(requestId, waiters);
        });
    }

    settle(request: UserInputRequest): void {
        this.requests.set(request.id, clone(request));
        if (request.status === "pending") return;
        const waiters = this.#waiters.get(request.id) ?? [];
        this.#waiters.delete(request.id);
        for (const resolve of waiters) resolve(clone(request));
    }

    #releaseWaiters(ids: readonly string[]): void {
        for (const id of ids) {
            const waiters = this.#waiters.get(id);
            if (waiters === undefined || waiters.length === 0) continue;
            this.#waiters.delete(id);
            const current = this.requests.get(id);
            if (current === undefined || current.status === "pending") continue;
            for (const resolve of waiters) resolve(clone(current));
        }
    }
}