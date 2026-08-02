import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import { slotEntries } from "../database/schema.js";
import type { TX } from "../Transaction.js";

export function slotEntryCreate(tx: TX, entry: SlotEntry): void {
    tx.insert(slotEntries)
        .values({
            authorSessionId: entry.authorSessionId,
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
}
