import { eq } from "drizzle-orm";

import { secretRegistrations, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function secretUnregister(tx: TX, secretId: string): void {
    inTx(tx, (tx) => {
        const rows = tx
            .select({ id: sessions.id, secretIdsJson: sessions.secretIdsJson })
            .from(sessions)
            .all();
        tx.delete(secretRegistrations).where(eq(secretRegistrations.id, secretId)).run();
        for (const row of rows) {
            const secretIds = JSON.parse(row.secretIdsJson) as string[];
            if (!secretIds.includes(secretId)) continue;
            tx.update(sessions)
                .set({ secretIdsJson: JSON.stringify(secretIds.filter((id) => id !== secretId)) })
                .where(eq(sessions.id, row.id))
                .run();
        }
    });
}
