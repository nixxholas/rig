import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { applets, appletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import type { AppletAllowedScopes } from "../../protocol/AppletProtocol.js";

/** Records a newly imported version and makes it current in one consistent step. */
export async function appletAddVersion(
    ctx: Context,
    name: string,
    version: number,
    changeDescription: string,
    now: number,
    allowedScopes?: AppletAllowedScopes,
): Promise<void> {
    await inTx(ctx, "rig.sql.applets.add_version", async (ctx) => {
        const transaction = ctx.tx;
        await transaction
            .insert(appletVersions)
            .values({
                changeDescription,
                createdAtMs: now,
                version,
                appletName: name,
            })
            .run();
        await transaction
            .update(applets)
            .set({
                currentVersion: version,
                updatedAtMs: now,
                ...(allowedScopes === undefined
                    ? {}
                    : { allowedScopesJson: JSON.stringify(allowedScopes) }),
            })
            .where(eq(applets.name, name))
            .run();
    });
}
