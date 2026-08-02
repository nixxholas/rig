import { sql } from "drizzle-orm";

import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import type { TX } from "../Transaction.js";
import { readSlotEntryRow } from "./querySlotEntries.js";

export function querySlotEntry(tx: TX, id: string): SlotEntry | undefined {
    const row = tx.get<Record<string, unknown>>(sql`SELECT * FROM slot_entries WHERE id = ${id}`);
    return row === undefined ? undefined : readSlotEntryRow(row);
}
