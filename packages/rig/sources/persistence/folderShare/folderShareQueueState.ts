import type { Context } from "@steve.kite/stdlib";

import { eq, sql } from "drizzle-orm";

import type {
    FolderShareOperation,
    FolderSharePacket,
    SharedFolderState,
} from "../../protocol/index.js";
import { MAX_SHARED_FOLDER_NODES } from "../../protocol/index.js";
import { folderShareNodes, folderShareOutbox, folderShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { queryFolderShare } from "./queryFolderShares.js";

const MAX_PENDING_FOLDER_SHARE_OPERATIONS = 10_000;

export async function folderShareQueueState(
    ctx: Context,
    input: {
        groupId: string;
        force?: boolean;
        now: number;
        operationId: string;
        sender: string;
        state: SharedFolderState;
    },
): Promise<FolderSharePacket | undefined> {
    return await inTx(ctx, "rig.sql.folderShare.folderShareQueueState", async (ctx) => {
        const tx = ctx.tx;
        const share = await queryFolderShare(ctx, input.groupId);
        if (share === undefined) return undefined;
        const operations = diffState(share.state, input.state);
        if (operations.length === 0 && input.force === true) {
            operations.push({ node: input.state.folders[0]!, type: "upsert" });
        }
        if (operations.length === 0) return undefined;
        const knownFolderIds = new Set(
            (
                await tx
                    .select({ folderId: folderShareNodes.folderId })
                    .from(folderShareNodes)
                    .where(eq(folderShareNodes.groupId, input.groupId))
                    .all()
            ).map((row) => row.folderId),
        );
        for (const operation of operations) {
            knownFolderIds.add(
                operation.type === "upsert" ? operation.node.id : operation.folderId,
            );
        }
        if (knownFolderIds.size > MAX_SHARED_FOLDER_NODES) {
            throw new Error("A shared folder cannot retain more folder identities.");
        }
        const pendingCount = (
            await tx.get<{ count: number }>(sql`
                SELECT COUNT(*) AS count
                FROM folder_share_outbox
            `)
        )?.count;
        if (pendingCount === undefined || pendingCount >= MAX_PENDING_FOLDER_SHARE_OPERATIONS) {
            throw new Error("Folder synchronization has too much pending work.");
        }
        const clock = share.logicalClock + 1;
        const packet: FolderSharePacket = {
            clock,
            operationId: input.operationId,
            operations,
            type: "operations",
            version: 1,
        };

        for (const operation of operations) {
            const folderId = operation.type === "upsert" ? operation.node.id : operation.folderId;
            const nodeJson = operation.type === "upsert" ? JSON.stringify(operation.node) : null;
            await tx
                .insert(folderShareNodes)
                .values({
                    folderId,
                    groupId: input.groupId,
                    logicalClock: clock,
                    nodeJson,
                    sender: input.sender,
                    updatedAtMs: input.now,
                })
                .onConflictDoUpdate({
                    target: [folderShareNodes.groupId, folderShareNodes.folderId],
                    set: {
                        logicalClock: clock,
                        nodeJson,
                        sender: input.sender,
                        updatedAtMs: input.now,
                    },
                })
                .run();
        }
        await tx
            .update(folderShares)
            .set({
                error: null,
                logicalClock: clock,
                stateJson: JSON.stringify(input.state),
                status: "syncing",
                updatedAtMs: input.now,
            })
            .where(eq(folderShares.groupId, input.groupId))
            .run();
        await tx
            .insert(folderShareOutbox)
            .values({
                createdAtMs: input.now,
                groupId: input.groupId,
                operationId: input.operationId,
                payloadJson: JSON.stringify(packet),
            })
            .run();
        return packet;
    });
}

function diffState(
    previous: SharedFolderState,
    current: SharedFolderState,
): FolderShareOperation[] {
    const before = new Map(previous.folders.map((node) => [node.id, node]));
    const after = new Set(current.folders.map((node) => node.id));
    const operations: FolderShareOperation[] = [];
    for (const node of current.folders) {
        const existing = before.get(node.id);
        if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(node)) {
            operations.push({ node, type: "upsert" });
        }
    }
    for (const node of previous.folders) {
        if (!after.has(node.id)) operations.push({ folderId: node.id, type: "remove" });
    }
    return operations;
}
