import { inDatabase } from "../database/inDatabase.js";
import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import { slotEntries } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";

export async function slotEntryCreate(tx: DatabaseScope, entry: SlotEntry): Promise<void> {
    return await inDatabase(tx, async (tx) => {
        await tx
            .insert(slotEntries)
            .values({
                authorId:
                    entry.author.type === "agent" ? entry.author.sessionId : entry.author.folder,
                authorName: entry.author.type === "plugin" ? entry.author.name : null,
                authorType: entry.author.type,
                contentJson: JSON.stringify(entry.content),
                createdAtMs: entry.createdAt,
                description: entry.description,
                id: entry.id,
                projectId: entry.projectId ?? null,
                purpose: entry.purpose,
                scope: entry.scope,
                sessionId: entry.sessionId ?? null,
                slot: entry.slot,
                updatedAtMs: entry.updatedAt,
                workspaceId: entry.workspaceId ?? null,
            })
            .run();
    });
}
