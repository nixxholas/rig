import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    sharedFolderStateSchema,
    type SharedFolderState,
} from "../../protocol/FolderSharingProtocol.js";
import { folderShareIntents } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export interface FolderShareIntent {
    rootFolderId: string;
    shareId: string;
    state: SharedFolderState;
}

export function folderSharePutIntent(tx: TX, input: FolderShareIntent & { now: number }): void {
    tx.insert(folderShareIntents)
        .values({
            createdAtMs: input.now,
            rootFolderId: input.rootFolderId,
            shareId: input.shareId,
            stateJson: JSON.stringify(input.state),
        })
        .onConflictDoUpdate({
            target: folderShareIntents.rootFolderId,
            set: {
                createdAtMs: input.now,
                shareId: input.shareId,
                stateJson: JSON.stringify(input.state),
            },
        })
        .run();
}

export function folderShareDeleteIntent(tx: TX, shareId: string): void {
    tx.delete(folderShareIntents).where(eq(folderShareIntents.shareId, shareId)).run();
}

export function queryFolderShareIntents(tx: TX): readonly FolderShareIntent[] {
    return tx
        .select()
        .from(folderShareIntents)
        .all()
        .map((row) => {
            const state: unknown = JSON.parse(row.stateJson);
            if (!Value.Check(sharedFolderStateSchema, state)) {
                throw new Error("A stored folder-sharing creation intent is invalid.");
            }
            return {
                rootFolderId: row.rootFolderId,
                shareId: row.shareId,
                state: state as SharedFolderState,
            };
        });
}

export function queryFolderShareIntentByRoot(
    tx: TX,
    rootFolderId: string,
): FolderShareIntent | undefined {
    return queryFolderShareIntents(tx).find((intent) => intent.rootFolderId === rootFolderId);
}
