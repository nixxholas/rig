import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { readSlotEntryRow } from "./querySlotEntries.js";

export async function querySlotEntry(
    tx: DatabaseScope,
    id: string,
): Promise<SlotEntry | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.get<Record<string, unknown>>(
            sql`SELECT * FROM slot_entries WHERE id = ${id}`,
        );
        return row === undefined ? undefined : readSlotEntryRow(row);
    });
}
