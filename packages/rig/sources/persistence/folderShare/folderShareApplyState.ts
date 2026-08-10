import type { Context } from "@steve.kite/stdlib";
import type { DatabaseScope } from "../Transaction.js";

import { and, eq, or, sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    MAX_SHARED_FOLDER_NODES,
    sharedFolderNodeSchema,
    type FolderSharePacket,
    type SharedFolderNode,
    type SharedFolderState,
} from "../../protocol/index.js";
import { folderShareNodes, folderShareUpdates, folderShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { inDatabase } from "../database/inDatabase.js";
import { queryFolderShare } from "./queryFolderShares.js";

const MAX_FOLDER_SHARE_UPDATE_RECEIPTS = 10_000;

export class FolderShareSemanticError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FolderShareSemanticError";
    }
}

export async function folderShareShouldApplyState(
    ctx: Context,
    groupId: string,
    deliveryId: string,
    packet: FolderSharePacket,
): Promise<"apply" | "duplicate"> {
    return await inDatabase(ctx, "rig.sql.folderShare.folderShareShouldApplyState", async (ctx) => {
        const tx = ctx.tx;
        const duplicate = await tx
            .select({ deliveryId: folderShareUpdates.deliveryId })
            .from(folderShareUpdates)
            .where(
                and(
                    eq(folderShareUpdates.groupId, groupId),
                    or(
                        eq(folderShareUpdates.operationId, packet.operationId),
                        eq(folderShareUpdates.deliveryId, deliveryId),
                    ),
                ),
            )
            .get();
        return duplicate === undefined ? "apply" : "duplicate";
    });
}

/**
 * Merges one authenticated operation batch and returns its deterministic reachable tree.
 *
 * Each folder is an independent LWW register. A missing/tombstoned parent makes descendants
 * temporarily unreachable without erasing their registers, so later parent restoration converges.
 */
export async function folderShareRecordAppliedState(
    ctx: Context,
    input: {
        deliveryId: string;
        groupId: string;
        now: number;
        packet: FolderSharePacket;
        sender: string;
    },
): Promise<SharedFolderState> {
    return await inTx(ctx, "rig.sql.folderShare.folderShareRecordAppliedState", async (ctx) => {
        const tx = ctx.tx;
        const share = await queryFolderShare(ctx, input.groupId);
        if (share === undefined) throw new Error("The shared folder group is unknown.");
        validateOperations(share.rootFolderId, input.packet);
        if (input.packet.clock > share.logicalClock + 1) {
            throw new FolderShareSemanticError(
                "A folder operation clock jumped ahead of the group.",
            );
        }
        const knownFolderIds = new Set(
            (
                await tx
                    .select({ folderId: folderShareNodes.folderId })
                    .from(folderShareNodes)
                    .where(eq(folderShareNodes.groupId, input.groupId))
                    .all()
            ).map((row) => row.folderId),
        );
        for (const operation of input.packet.operations) {
            const folderId = operation.type === "upsert" ? operation.node.id : operation.folderId;
            knownFolderIds.add(folderId);
        }
        if (knownFolderIds.size > MAX_SHARED_FOLDER_NODES) {
            throw new FolderShareSemanticError(
                "A shared folder cannot retain more folder identities.",
            );
        }
        for (const operation of input.packet.operations) {
            const folderId = operation.type === "upsert" ? operation.node.id : operation.folderId;
            const current = await tx
                .select({
                    logicalClock: folderShareNodes.logicalClock,
                    sender: folderShareNodes.sender,
                })
                .from(folderShareNodes)
                .where(
                    and(
                        eq(folderShareNodes.groupId, input.groupId),
                        eq(folderShareNodes.folderId, folderId),
                    ),
                )
                .get();
            if (
                current !== undefined &&
                compareVersion(
                    input.packet.clock,
                    input.sender,
                    current.logicalClock,
                    current.sender,
                ) <= 0
            ) {
                continue;
            }
            const nodeJson = operation.type === "upsert" ? JSON.stringify(operation.node) : null;
            await tx
                .insert(folderShareNodes)
                .values({
                    folderId,
                    groupId: input.groupId,
                    logicalClock: input.packet.clock,
                    nodeJson,
                    sender: input.sender,
                    updatedAtMs: input.now,
                })
                .onConflictDoUpdate({
                    target: [folderShareNodes.groupId, folderShareNodes.folderId],
                    set: {
                        logicalClock: input.packet.clock,
                        nodeJson,
                        sender: input.sender,
                        updatedAtMs: input.now,
                    },
                })
                .run();
        }
        const state = await materializeState(tx, input.groupId, share.rootFolderId);
        await recordReceipt(tx, input);
        await tx
            .update(folderShares)
            .set({
                error: null,
                lastSyncedAtMs: input.now,
                logicalClock: Math.max(share.logicalClock, input.packet.clock),
                stateJson: JSON.stringify(state),
                status: "synced",
                updatedAtMs: input.now,
            })
            .where(eq(folderShares.groupId, input.groupId))
            .run();
        return state;
    });
}

/** Durably consumes a validly encoded but semantically unusable authenticated update. */
export async function folderShareRecordRejectedState(
    ctx: Context,
    input: {
        deliveryId: string;
        error: string;
        groupId: string;
        now: number;
        packet: FolderSharePacket;
        sender: string;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.folderShare.folderShareRecordRejectedState", async (ctx) => {
        const tx = ctx.tx;
        await recordReceipt(tx, input);
        await tx
            .update(folderShares)
            .set({ error: input.error, status: "error", updatedAtMs: input.now })
            .where(eq(folderShares.groupId, input.groupId))
            .run();
    });
}

async function recordReceipt(
    tx: DatabaseScope,
    input: {
        deliveryId: string;
        groupId: string;
        now: number;
        packet: FolderSharePacket;
        sender: string;
    },
): Promise<void> {
    await tx
        .insert(folderShareUpdates)
        .values({
            createdAtMs: input.now,
            deliveryId: input.deliveryId,
            groupId: input.groupId,
            logicalClock: input.packet.clock,
            operationId: input.packet.operationId,
            sender: input.sender,
        })
        .onConflictDoNothing()
        .run();
    await tx.run(sql`
        DELETE FROM folder_share_updates
        WHERE delivery_id IN (
            SELECT delivery_id
            FROM folder_share_updates
            ORDER BY created_at_ms DESC, delivery_id DESC
            LIMIT -1 OFFSET ${MAX_FOLDER_SHARE_UPDATE_RECEIPTS}
        )
    `);
}

function validateOperations(rootFolderId: string, packet: FolderSharePacket): void {
    const seen = new Set<string>();
    for (const operation of packet.operations) {
        const folderId = operation.type === "upsert" ? operation.node.id : operation.folderId;
        if (seen.has(folderId)) {
            throw new FolderShareSemanticError("A folder operation batch repeats a folder.");
        }
        seen.add(folderId);
        if (folderId === rootFolderId) {
            if (operation.type === "remove" || operation.node.parentId !== undefined) {
                throw new FolderShareSemanticError(
                    "A shared-folder operation cannot remove or nest its root.",
                );
            }
        } else if (operation.type === "upsert" && operation.node.parentId === undefined) {
            throw new FolderShareSemanticError(
                "A shared-folder operation must place a child under a folder.",
            );
        }
    }
}

async function materializeState(
    tx: DatabaseScope,
    groupId: string,
    rootId: string,
): Promise<SharedFolderState> {
    const live = new Map<string, SharedFolderNode>();
    for (const row of await tx
        .select({ folderId: folderShareNodes.folderId, nodeJson: folderShareNodes.nodeJson })
        .from(folderShareNodes)
        .where(eq(folderShareNodes.groupId, groupId))
        .all()) {
        if (row.nodeJson === null) continue;
        const decoded: unknown = JSON.parse(row.nodeJson);
        if (!Value.Check(sharedFolderNodeSchema, decoded)) {
            throw new Error("A stored shared-folder node is invalid.");
        }
        live.set(row.folderId, decoded as SharedFolderNode);
    }
    const root = live.get(rootId);
    if (root === undefined || root.parentId !== undefined) {
        throw new Error("A shared folder has no active root.");
    }
    if (live.size > MAX_SHARED_FOLDER_NODES) {
        throw new Error("A stored shared folder contains too many active folders.");
    }
    const effectiveParents = new Map<string, string>();
    for (const node of live.values()) {
        if (node.id !== rootId && node.parentId !== undefined) {
            effectiveParents.set(node.id, node.parentId);
        }
    }
    breakParentCycles(effectiveParents, live, rootId);
    const children = new Map<string, SharedFolderNode[]>();
    for (const node of live.values()) {
        const parentId = effectiveParents.get(node.id);
        if (node.id === rootId || parentId === undefined) continue;
        const effectiveNode = parentId === node.parentId ? node : { ...node, parentId };
        const siblings = children.get(parentId);
        if (siblings === undefined) children.set(parentId, [effectiveNode]);
        else siblings.push(effectiveNode);
    }
    for (const siblings of children.values()) {
        siblings.sort((left, right) => left.order - right.order || compareIds(left.id, right.id));
    }
    const folders: SharedFolderNode[] = [{ ...root, order: 0 }];
    const placed = new Set([rootId]);
    const visit = (parentId: string): void => {
        let order = 0;
        for (const node of children.get(parentId) ?? []) {
            if (placed.has(node.id)) continue;
            placed.add(node.id);
            folders.push({ ...node, order });
            order += 1;
            visit(node.id);
        }
    };
    visit(rootId);
    return { folders, rootId };
}

/** Breaks each live parent cycle by deterministically attaching its smallest ID to the root. */
function breakParentCycles(
    parents: Map<string, string>,
    live: ReadonlyMap<string, SharedFolderNode>,
    rootId: string,
): void {
    const resolved = new Set<string>([rootId]);
    for (const start of [...live.keys()].sort(compareIds)) {
        if (resolved.has(start)) continue;
        const path: string[] = [];
        const positions = new Map<string, number>();
        let current: string | undefined = start;
        while (
            current !== undefined &&
            current !== rootId &&
            live.has(current) &&
            !resolved.has(current)
        ) {
            const position = positions.get(current);
            if (position !== undefined) {
                const cycle = path.slice(position);
                const breaker = [...cycle].sort(compareIds)[0]!;
                parents.set(breaker, rootId);
                break;
            }
            positions.set(current, path.length);
            path.push(current);
            current = parents.get(current);
        }
        for (const folderId of path) resolved.add(folderId);
    }
}

function compareVersion(
    leftClock: number,
    leftSender: string,
    rightClock: number,
    rightSender: string,
): number {
    return (
        leftClock - rightClock || (leftSender < rightSender ? -1 : leftSender > rightSender ? 1 : 0)
    );
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
