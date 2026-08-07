import { eq } from "drizzle-orm";

import { applets, appletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { AppletAllowedScopes } from "../../protocol/AppletProtocol.js";

/** Records a newly imported version and makes it current in one consistent step. */
export function appletAddVersion(
    tx: TX,
    name: string,
    version: number,
    changeDescription: string,
    now: number,
    allowedScopes?: AppletAllowedScopes,
): void {
    inTx(tx, (transaction) => {
        transaction
            .insert(appletVersions)
            .values({
                changeDescription,
                createdAtMs: now,
                version,
                appletName: name,
            })
            .run();
        transaction
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
