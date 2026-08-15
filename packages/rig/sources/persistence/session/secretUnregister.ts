import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import { secretRegistrations, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";

export async function secretUnregister(ctx: Context, secretId: string): Promise<void> {
    await inTx(ctx, "rig.sql.session.secret_unregister", async (ctx) => {
        const tx = ctx.tx;
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
