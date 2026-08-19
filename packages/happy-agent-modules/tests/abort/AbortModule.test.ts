import type { AgentSystemRef } from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

class Collection {
    readonly aborted: string[] = [];
    readonly databases: unknown[] = [];
    readonly children = new Map<string, readonly string[]>();
    abortFailureAgentId: string | undefined;

    async childOf(ctx: Context, agentId: string): Promise<readonly string[]> {
        this.databases.push(ctx.db);
        return this.children.get(agentId) ?? [];
    }

    async abort(ctx: Context, agentId: string): Promise<void> {
        this.databases.push(ctx.db);
        if (agentId === this.abortFailureAgentId) throw new Error("abort failed");
        afterCommit(ctx, () => {
            this.aborted.push(agentId);
        });
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

async function started(name: string, collection: Collection) {
    const database = moduleDatabase([], name);
    await database.ready;
    const abort = new AbortModule();
    await resolveModuleHooks(database.context, abort, collection.asRef());
    return { abort, database };
}

function seedTree(collection: Collection): void {
    collection.children.set("root", ["child-a", "child-b"]);
    collection.children.set("child-a", ["grandchild"]);
}

describe("AbortModule", () => {
    it("releases the target and its entire descendant chain after one transaction commits", async () => {
        const collection = new Collection();
        seedTree(collection);
        const { abort, database } = await started("abort-chain-commit", collection);
        try {
            await abort.abort(database.context, "root");

            expect(collection.aborted).toEqual(["root", "child-a", "child-b", "grandchild"]);
            expect(new Set(collection.databases).size).toBe(1);
            expect(collection.databases[0]).not.toBe(database.database);
        } finally {
            database.close();
        }
    });

    it("joins an outer transaction and releases no cancellation before its commit", async () => {
        const collection = new Collection();
        seedTree(collection);
        const { abort, database } = await started("abort-chain-nested", collection);
        try {
            await database.context.inTx(async (txCtx) => {
                await abort.abort(txCtx, "root");
                expect(collection.aborted).toEqual([]);
                expect(new Set(collection.databases)).toEqual(new Set([txCtx.db]));
            });

            expect(collection.aborted).toEqual(["root", "child-a", "child-b", "grandchild"]);
        } finally {
            database.close();
        }
    });

    it("drops every queued cancellation when the outer transaction rolls back", async () => {
        const collection = new Collection();
        seedTree(collection);
        const { abort, database } = await started("abort-chain-rollback", collection);
        try {
            await expect(
                database.context.inTx(async (txCtx) => {
                    await abort.abort(txCtx, "root");
                    throw new Error("roll back");
                }),
            ).rejects.toThrow("roll back");
            expect(collection.aborted).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("rolls back earlier abort requests when any target cannot be aborted", async () => {
        const collection = new Collection();
        seedTree(collection);
        collection.abortFailureAgentId = "child-b";
        const { abort, database } = await started("abort-chain-target-failure", collection);
        try {
            await expect(abort.abort(database.context, "root")).rejects.toThrow("abort failed");
            expect(collection.aborted).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("rejects cyclic ancestry before releasing any cancellation", async () => {
        const collection = new Collection();
        collection.children.set("root", ["child"]);
        collection.children.set("child", ["root"]);
        const { abort, database } = await started("abort-chain-cycle", collection);
        try {
            await expect(abort.abort(database.context, "root")).rejects.toThrow(
                "cycle or duplicate identity",
            );
            expect(collection.aborted).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("refuses to abort before the module has an agent collection", async () => {
        const database = moduleDatabase([], "abort-chain-unstarted");
        await database.ready;
        try {
            await expect(new AbortModule().abort(database.context, "root")).rejects.toThrow(
                "has not been started yet",
            );
        } finally {
            database.close();
        }
    });
});
