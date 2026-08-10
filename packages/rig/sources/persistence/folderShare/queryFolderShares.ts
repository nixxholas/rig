import type { Context } from "@steve.kite/stdlib";

import { asc, eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    sharedFolderStateSchema,
    type SharedFolderState,
} from "../../protocol/FolderSharingProtocol.js";
import { folderShareOutbox, folderShares } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";

export interface FolderShareRecord {
    error?: string;
    groupId: string;
    lastSyncedAt?: number;
    logicalClock: number;
    rootFolderId: string;
    shareId: string;
    state: SharedFolderState;
    status: "error" | "synced" | "syncing";
}

export interface FolderShareOutboxRecord {
    groupId: string;
    operationId: string;
    payloadJson: string;
}

export async function queryFolderShares(ctx: Context): Promise<readonly FolderShareRecord[]> {
    return await inDatabase(ctx, "rig.sql.folderShare.queryFolderShares", async (ctx) => {
        const tx = ctx.tx;
        const rows = await tx
            .select()
            .from(folderShares)
            .orderBy(asc(folderShares.createdAtMs), asc(folderShares.groupId))
            .all();
        return rows.map(readShare);
    });
}

export async function queryFolderShare(
    ctx: Context,
    groupId: string,
): Promise<FolderShareRecord | undefined> {
    return await inDatabase(ctx, "rig.sql.folderShare.queryFolderShare", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select()
            .from(folderShares)
            .where(eq(folderShares.groupId, groupId))
            .get();
        return row === undefined ? undefined : readShare(row);
    });
}

export async function queryFolderShareByShareId(
    ctx: Context,
    shareId: string,
): Promise<FolderShareRecord | undefined> {
    return await inDatabase(ctx, "rig.sql.folderShare.queryFolderShareByShareId", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx
            .select()
            .from(folderShares)
            .where(eq(folderShares.shareId, shareId))
            .get();
        return row === undefined ? undefined : readShare(row);
    });
}

export async function queryPendingFolderShareOutbox(
    ctx: Context,
): Promise<readonly FolderShareOutboxRecord[]> {
    return await inDatabase(
        ctx,
        "rig.sql.folderShare.queryPendingFolderShareOutbox",
        async (ctx) =>
            await ctx.tx
                .select({
                    groupId: folderShareOutbox.groupId,
                    operationId: folderShareOutbox.operationId,
                    payloadJson: folderShareOutbox.payloadJson,
                })
                .from(folderShareOutbox)
                .orderBy(asc(folderShareOutbox.createdAtMs), asc(folderShareOutbox.operationId))
                .all(),
    );
}

function readShare(row: typeof folderShares.$inferSelect): FolderShareRecord {
    const decoded: unknown = JSON.parse(row.stateJson);
    if (!Value.Check(sharedFolderStateSchema, decoded)) {
        throw new Error("A stored shared-folder state is invalid.");
    }
    return {
        ...(row.error === null ? {} : { error: row.error }),
        groupId: row.groupId,
        ...(row.lastSyncedAtMs === null ? {} : { lastSyncedAt: row.lastSyncedAtMs }),
        logicalClock: row.logicalClock,
        rootFolderId: row.rootFolderId,
        shareId: row.shareId,
        state: decoded as SharedFolderState,
        status: row.status,
    };
}
