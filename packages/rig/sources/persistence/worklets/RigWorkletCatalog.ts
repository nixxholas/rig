import {
    assertWorklet,
    assertWorkletProof,
    assertWorkletReceipt,
    assertWorkletOperationList,
    type Worklet,
    type WorkletCatalog,
    type WorkletCatalogInstallInput,
    type WorkletCatalogInstallResult,
    type WorkletCatalogMutationProof,
    type WorkletCatalogMutationReceipt,
    type WorkletCatalogRemoveResult,
    type WorkletCatalogRevertInput,
    type WorkletCatalogRevertResult,
    type WorkletCatalogUpdateInput,
    type WorkletCatalogUpdateResult,
    type WorkletListPage,
    type WorkletListQuery,
    type WorkletOperation,
    type WorkletVersion,
} from "@slopus/happy-agent-features";
import type { Context } from "@steve.kite/stdlib";
import { asc, eq } from "drizzle-orm";

import {
    workletMutationProofs,
    workletMutationReceipts,
    worklets,
    workletVersions,
} from "../database/schema.js";
import type { SessionDatabase } from "../database/SessionDatabase.js";
import {
    deferSessionTransactionCommit,
    deferSessionTransactionRollback,
    runSessionTransaction,
} from "../database/SessionTransactionContext.js";
import { withDatabase } from "../databaseContext.js";

/** Durable SQLite catalog consumed directly by the feature-owned worklet implementation. */
export class RigWorkletCatalog implements WorkletCatalog {
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase) {
        this.#database = database;
    }

    async transaction(
        ctx: Context,
        work: (ctx: Context) => Promise<unknown>,
    ): Promise<unknown> {
        return await runSessionTransaction(withDatabase(ctx, this.#database), work);
    }

    afterCommit(ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        void deferSessionTransactionCommit(() => callback(ctx), this.#database);
    }

    onRollback(ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        deferSessionTransactionRollback(() => callback(ctx), this.#database);
    }

    async list(ctx: Context, query: WorkletListQuery): Promise<WorkletListPage> {
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? 50;
        const rows = await withDatabase(ctx, this.#database).tx
            .select({ name: worklets.name })
            .from(worklets)
            .orderBy(asc(worklets.name))
            .limit(limit + 1)
            .offset(cursor)
            .all();
        const hasMore = rows.length > limit;
        const selected = rows.slice(0, limit);
        const found: Worklet[] = [];
        for (const row of selected) found.push(await this.#require(ctx, row.name));
        return {
            worklets: found,
            limit,
            hasMore,
            ...(cursor > 0 ? { previousCursor: Math.max(0, cursor - limit) } : {}),
            ...(hasMore ? { nextCursor: cursor + found.length } : {}),
        } as WorkletListPage;
    }

    async get(ctx: Context, name: string): Promise<Worklet | undefined> {
        const scope = withDatabase(ctx, this.#database);
        const row = await scope.tx
            .select()
            .from(worklets)
            .where(eq(worklets.name, name))
            .get();
        if (row === undefined) return undefined;
        const versionRows = await scope.tx
            .select()
            .from(workletVersions)
            .where(eq(workletVersions.workletName, name))
            .orderBy(asc(workletVersions.version))
            .all();
        const versions: WorkletVersion[] = versionRows.map((version) => ({
            version: version.version,
            sourceRef: version.sourceRef,
            changeDescription: version.changeDescription,
            operations: decodeOperations(version.operationsJson),
            createdAt: version.createdAtMs,
            operationId: version.operationId,
        }));
        const current = versions.find((version) => version.version === row.currentVersion);
        if (current === undefined) {
            throw new Error(`Worklet "${name}" has no current version.`);
        }
        const worklet: Worklet = {
            name: row.name,
            ownerAgentId: row.ownerAgentId,
            currentVersion: row.currentVersion,
            operations: [...current.operations],
            versions,
            createdAt: row.createdAtMs,
            updatedAt: row.updatedAtMs,
        };
        assertWorklet(worklet);
        return worklet;
    }

    async install(
        ctx: Context,
        input: WorkletCatalogInstallInput,
    ): Promise<WorkletCatalogInstallResult> {
        const scope = withDatabase(ctx, this.#database);
        await scope.tx
            .insert(worklets)
            .values({
                name: input.name,
                ownerAgentId: input.ownerAgentId,
                currentVersion: 1,
                createdAtMs: input.initialVersion.createdAt,
                updatedAtMs: input.initialVersion.createdAt,
            })
            .run();
        await scope.tx
            .insert(workletVersions)
            .values({
                workletName: input.name,
                version: 1,
                sourceRef: input.initialVersion.sourceRef,
                changeDescription: input.initialVersion.changeDescription,
                operationsJson: JSON.stringify(input.initialVersion.operations),
                createdAtMs: input.initialVersion.createdAt,
                operationId: input.operationId,
            })
            .run();
        const worklet = await this.#require(ctx, input.name);
        return {
            operation: "install",
            name: input.name,
            operationId: input.operationId,
            targetVersion: 1,
            currentVersion: worklet.currentVersion,
            changed: true,
            worklet,
        };
    }

    async update(
        ctx: Context,
        name: string,
        input: WorkletCatalogUpdateInput,
    ): Promise<WorkletCatalogUpdateResult> {
        const scope = withDatabase(ctx, this.#database);
        await scope.tx
            .insert(workletVersions)
            .values({
                workletName: name,
                version: input.version,
                sourceRef: input.sourceRef,
                changeDescription: input.changeDescription,
                operationsJson: JSON.stringify(input.operations),
                createdAtMs: input.createdAt,
                operationId: input.operationId,
            })
            .run();
        await scope.tx
            .update(worklets)
            .set({ currentVersion: input.version, updatedAtMs: input.createdAt })
            .where(eq(worklets.name, name))
            .run();
        const worklet = await this.#require(ctx, name);
        return {
            operation: "update",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: worklet.currentVersion,
            changed: true,
            worklet,
        };
    }

    async revert(
        ctx: Context,
        name: string,
        input: WorkletCatalogRevertInput,
    ): Promise<WorkletCatalogRevertResult> {
        const before = await this.#require(ctx, name);
        const changed = before.currentVersion !== input.version;
        if (changed) {
            await withDatabase(ctx, this.#database).tx
                .update(worklets)
                .set({ currentVersion: input.version })
                .where(eq(worklets.name, name))
                .run();
        }
        const worklet = await this.#require(ctx, name);
        return {
            operation: "revert",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: worklet.currentVersion,
            changed,
            worklet,
        };
    }

    async remove(
        ctx: Context,
        name: string,
        operationId: string,
    ): Promise<WorkletCatalogRemoveResult> {
        const before = await this.get(ctx, name);
        if (before !== undefined) {
            await withDatabase(ctx, this.#database).tx
                .delete(worklets)
                .where(eq(worklets.name, name))
                .run();
        }
        return {
            operation: "remove",
            name,
            operationId,
            targetVersion: 0,
            currentVersion: 0,
            changed: before !== undefined,
            removed: before !== undefined,
        };
    }

    async readReceipt(
        ctx: Context,
        operationId: string,
    ): Promise<WorkletCatalogMutationReceipt | undefined> {
        const row = await withDatabase(ctx, this.#database).tx
            .select({ json: workletMutationReceipts.receiptJson })
            .from(workletMutationReceipts)
            .where(eq(workletMutationReceipts.operationId, operationId))
            .get();
        if (row === undefined) return undefined;
        const receipt: unknown = JSON.parse(row.json);
        assertWorkletReceipt(receipt);
        return receipt;
    }

    async writeReceipt(ctx: Context, receipt: WorkletCatalogMutationReceipt): Promise<void> {
        assertWorkletReceipt(receipt);
        await withDatabase(ctx, this.#database).tx
            .insert(workletMutationReceipts)
            .values({ operationId: receipt.operationId, receiptJson: JSON.stringify(receipt) })
            .run();
    }

    async readMutationProof(
        ctx: Context,
        operationId: string,
    ): Promise<WorkletCatalogMutationProof | undefined> {
        const row = await withDatabase(ctx, this.#database).tx
            .select({ json: workletMutationProofs.proofJson })
            .from(workletMutationProofs)
            .where(eq(workletMutationProofs.operationId, operationId))
            .get();
        if (row === undefined) return undefined;
        const proof: unknown = JSON.parse(row.json);
        assertWorkletProof(proof);
        return proof;
    }

    async writeMutationProof(ctx: Context, proof: WorkletCatalogMutationProof): Promise<void> {
        assertWorkletProof(proof);
        await withDatabase(ctx, this.#database).tx
            .insert(workletMutationProofs)
            .values({ operationId: proof.operationId, proofJson: JSON.stringify(proof) })
            .run();
    }

    async #require(ctx: Context, name: string): Promise<Worklet> {
        const worklet = await this.get(ctx, name);
        if (worklet === undefined) throw new Error(`Worklet "${name}" was not found.`);
        return worklet;
    }
}

function decodeOperations(value: string): WorkletOperation[] {
    const parsed: unknown = JSON.parse(value);
    assertWorkletOperationList(parsed);
    return [...parsed];
}
