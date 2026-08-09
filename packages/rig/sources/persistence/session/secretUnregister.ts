import { eq } from "drizzle-orm";

import { secretRegistrations, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function secretUnregister(tx: DatabaseScope, secretId: string): Promise<void> {
    await inTx(tx, async (tx) => {
        const rows = await tx
            .select({ id: sessions.id, secretIdsJson: sessions.secretIdsJson })
            .from(sessions)
            .all();
        await tx.delete(secretRegistrations).where(eq(secretRegistrations.id, secretId)).run();
        for (const row of rows) {
            const secretIds = JSON.parse(row.secretIdsJson) as string[];
            if (!secretIds.includes(secretId)) continue;
            await tx
                .update(sessions)
                .set({ secretIdsJson: JSON.stringify(secretIds.filter((id) => id !== secretId)) })
                .where(eq(sessions.id, row.id))
                .run();
        }
    });
}
