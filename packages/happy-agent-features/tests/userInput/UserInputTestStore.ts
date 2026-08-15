import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import {
    type UserInputListQuery,
    type UserInputPage,
    type UserInputRequest,
    type UserInputTerminalRequest,
} from "../../sources/userInput/UserInputRequest.js";
import {
    type UserInputMutationProof,
    type UserInputMutationReceipt,
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

export class UserInputTestStore implements UserInputStore {
    readonly requests = new Map<string, UserInputRequest>();
    readonly receipts = new Map<string, UserInputMutationReceipt>();
    readonly proofs = new Map<string, UserInputMutationProof>();
    readonly postCommit: Array<(ctx: Context) => void | Promise<void>> = [];
    readonly calls: string[] = [];
    waitCalledInsideTransaction = false;
    #transactionDepth = 0;
    #activeTransactionToken: symbol | undefined;
    #queue: Promise<void> = Promise.resolve();
    #snapshot:
        | {
              readonly requests: Map<string, UserInputRequest>;
              readonly receipts: Map<string, UserInputMutationReceipt>;
              readonly proofs: Map<string, UserInputMutationProof>;
          }
        | undefined;
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
            this.#snapshot = {
                requests: new Map([...this.requests].map(([id, value]) => [id, clone(value)])),
                receipts: new Map([...this.receipts].map(([key, value]) => [key, clone(value)])),
                proofs: new Map([...this.proofs].map(([key, value]) => [key, clone(value)])),
            };
            this.#pendingWaiterReleases.clear();
            const transactionToken = Symbol("user-input-test-transaction");
            this.#activeTransactionToken = transactionToken;
            this.#transactionDepth = 1;
            const txCtx = transactionTokenNamespace.set(ctx, transactionToken);
            try {
                const result = await work(txCtx);
                const callbacks = this.postCommit.splice(0);
                const releaseIds = [...this.#pendingWaiterReleases];
                this.#pendingWaiterReleases.clear();
                this.#transactionDepth = 0;
                this.#activeTransactionToken = undefined;
                this.#snapshot = undefined;
                return { result: clone(result), callbacks, releaseIds };
            } catch (error: unknown) {
                this.#transactionDepth = 0;
                this.#activeTransactionToken = undefined;
                const snapshot = this.#snapshot;
                this.#snapshot = undefined;
                if (snapshot !== undefined) {
                    this.#restore(this.requests, snapshot.requests);
                    this.#restore(this.receipts, snapshot.receipts);
                    this.#restore(this.proofs, snapshot.proofs);
                }
                this.#pendingWaiterReleases.clear();
                this.postCommit.splice(0);
                throw error;
            }
        });
        this.#queue = run.then(
            () => undefined,
            () => undefined,
        );
        const committed = await run;
        let callbackError: unknown;
        for (const callback of committed.callbacks) {
            try {
                await callback(ctx);
            } catch (error: unknown) {
                callbackError ??= error;
            }
        }
        this.#releaseWaiters(committed.releaseIds);
        if (callbackError !== undefined) throw callbackError;
        return committed.result;
    }

    afterCommit(_ctx: Context, callback: (postCommitCtx: Context) => void | Promise<void>): void {
        this.postCommit.push(callback);
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
        const nextCursor =
            start + requests.length < rows.length ? String(start + requests.length) : undefined;
        return {
            requests,
            cursor: String(start),
            limit,
            ...(start > 0 ? { previousCursor: String(Math.max(0, start - limit)) } : {}),
            ...(nextCursor === undefined ? {} : { nextCursor }),
        };
    }

    async readReceipt(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<UserInputMutationReceipt | undefined> {
        const value = this.receipts.get(`${actingAgentId}:${operationId}`);
        return value === undefined ? undefined : clone(value);
    }

    async writeReceipt(_ctx: Context, receipt: UserInputMutationReceipt): Promise<void> {
        this.receipts.set(`${receipt.actingAgentId}:${receipt.operationId}`, clone(receipt));
    }

    async readMutationProof(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<UserInputMutationProof | undefined> {
        const value = this.proofs.get(`${actingAgentId}:${operationId}`);
        return value === undefined ? undefined : clone(value);
    }

    async writeMutationProof(
        _ctx: Context,
        proof: UserInputMutationProof,
        _mode: "if_absent",
    ): Promise<void> {
        const key = `${proof.actingAgentId}:${proof.operationId}`;
        const existing = this.proofs.get(key);
        if (existing !== undefined && !sameValue(existing, proof)) {
            throw new Error("immutable proof already exists");
        }
        if (existing === undefined) this.proofs.set(key, clone(proof));
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

    #restore<Value>(target: Map<string, Value>, snapshot: Map<string, Value>): void {
        target.clear();
        for (const [key, value] of snapshot) target.set(key, clone(value));
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

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}