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
import type { TX } from "../Transaction.js";
import { queryFolderShare } from "./queryFolderShares.js";

const MAX_FOLDER_SHARE_UPDATE_RECEIPTS = 10_000;

export class FolderShareSemanticError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FolderShareSemanticError";
    }
}

export function folderShareShouldApplyState(
    tx: TX,
    groupId: string,
    deliveryId: string,
    packet: FolderSharePacket,
): "apply" | "duplicate" {
    const duplicate = tx
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
}

/**
 * Merges one authenticated operation batch and returns its deterministic reachable tree.
 *
 * Each folder is an independent LWW register. A missing/tombstoned parent makes descendants
 * temporarily unreachable without erasing their registers, so later parent restoration converges.
 */
export function folderShareRecordAppliedState(
    tx: TX,
    input: {
        deliveryId: string;
        groupId: string;
        now: number;
        packet: FolderSharePacket;
        sender: string;
    },
): SharedFolderState {
    return inTx(tx, (tx) => {
        const share = queryFolderShare(tx, input.groupId);
        if (share === undefined) throw new Error("The shared folder group is unknown.");
        validateOperations(share.rootFolderId, input.packet);
        if (input.packet.clock > share.logicalClock + 1) {
            throw new FolderShareSemanticError(
                "A folder operation clock jumped ahead of the group.",
            );
        }
        const knownFolderIds = new Set(
            tx
                .select({ folderId: folderShareNodes.folderId })
                .from(folderShareNodes)
                .where(eq(folderShareNodes.groupId, input.groupId))
                .all()
                .map((row) => row.folderId),
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
            const current = tx
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
            tx.insert(folderShareNodes)
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
        const state = materializeState(tx, input.groupId, share.rootFolderId);
        recordReceipt(tx, input);
        tx.update(folderShares)
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
export function folderShareRecordRejectedState(
    tx: TX,
    input: {
        deliveryId: string;
        error: string;
        groupId: string;
        now: number;
        packet: FolderSharePacket;
        sender: string;
    },
): void {
    inTx(tx, (tx) => {
        recordReceipt(tx, input);
        tx.update(folderShares)
            .set({ error: input.error, status: "error", updatedAtMs: input.now })
            .where(eq(folderShares.groupId, input.groupId))
            .run();
    });
}

function recordReceipt(
    tx: TX,
    input: {
        deliveryId: string;
        groupId: string;
        now: number;
        packet: FolderSharePacket;
        sender: string;
    },
): void {
    tx.insert(folderShareUpdates)
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
    tx.run(sql`
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

function materializeState(tx: TX, groupId: string, rootId: string): SharedFolderState {
    const live = new Map<string, SharedFolderNode>();
    for (const row of tx
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
