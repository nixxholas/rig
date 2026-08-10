import type { Context } from "@steve.kite/stdlib";

import { folderShareNodes, folderShares } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { SharedFolderState } from "../../protocol/FolderSharingProtocol.js";
import { queryFolderShare } from "./queryFolderShares.js";

export async function folderShareCreate(
    ctx: Context,
    input: {
        groupId: string;
        now: number;
        rootFolderId: string;
        shareId: string;
        sender: string;
        state: SharedFolderState;
        status: "synced" | "syncing";
    },
): Promise<"created" | "existing"> {
    return await inTx(ctx, "rig.sql.folderShare.folderShareCreate", async (ctx) => {
        const tx = ctx.tx;
        const existing = await queryFolderShare(ctx, input.groupId);
        if (existing !== undefined) {
            if (existing.rootFolderId !== input.rootFolderId) {
                throw new Error("A Murmur folder group cannot change its root.");
            }
            return "existing";
        }
        await tx
            .insert(folderShares)
            .values({
                createdAtMs: input.now,
                groupId: input.groupId,
                lastSyncedAtMs: input.status === "synced" ? input.now : null,
                logicalClock: 0,
                rootFolderId: input.rootFolderId,
                shareId: input.shareId,
                stateJson: JSON.stringify(input.state),
                status: input.status,
                updatedAtMs: input.now,
            })
            .run();
        await tx
            .insert(folderShareNodes)
            .values(
                input.state.folders.map((node) => ({
                    folderId: node.id,
                    groupId: input.groupId,
                    logicalClock: 0,
                    nodeJson: JSON.stringify(node),
                    sender: input.sender,
                    updatedAtMs: input.now,
                })),
            )
            .run();
        return "created";
    });
}
