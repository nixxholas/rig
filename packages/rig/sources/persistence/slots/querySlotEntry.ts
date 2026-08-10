import { inDatabase } from "../database/inDatabase.js";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { SlotEntry } from "../../protocol/SlotProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { readSlotEntryRow } from "./querySlotEntries.js";

export async function querySlotEntry(ctx: Context, id: string): Promise<SlotEntry | undefined> {
    return await inDatabase(ctx, "rig.sql.slots.query_entry", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.get<Record<string, unknown>>(
            sql`SELECT * FROM slot_entries WHERE id = ${id}`,
        );
        return row === undefined ? undefined : readSlotEntryRow(row);
    });
}
