import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    sharedFolderStateSchema,
    type SharedFolderState,
} from "../../protocol/FolderSharingProtocol.js";
import { folderShareIntents } from "../database/schema.js";
import { inDatabase } from "../database/inDatabase.js";
import type { DatabaseScope } from "../Transaction.js";

export interface FolderShareIntent {
    rootFolderId: string;
    shareId: string;
    state: SharedFolderState;
}

export async function folderSharePutIntent(
    tx: DatabaseScope,
    input: FolderShareIntent & { now: number },
): Promise<void> {
    await inDatabase(tx, async (tx) => {
        await tx
            .insert(folderShareIntents)
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
    });
}

export async function folderShareDeleteIntent(tx: DatabaseScope, shareId: string): Promise<void> {
    await inDatabase(tx, async (tx) => {
        await tx.delete(folderShareIntents).where(eq(folderShareIntents.shareId, shareId)).run();
    });
}

export async function queryFolderShareIntents(
    tx: DatabaseScope,
): Promise<readonly FolderShareIntent[]> {
    return await inDatabase(tx, async (tx) => {
        const rows = await tx.select().from(folderShareIntents).all();
        return rows.map((row) => {
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
    });
}

export async function queryFolderShareIntentByRoot(
    tx: DatabaseScope,
    rootFolderId: string,
): Promise<FolderShareIntent | undefined> {
    return (await queryFolderShareIntents(tx)).find(
        (intent) => intent.rootFolderId === rootFolderId,
    );
}
