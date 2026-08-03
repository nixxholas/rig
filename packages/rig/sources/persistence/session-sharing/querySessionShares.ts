import { asc, eq, ne } from "drizzle-orm";

import { sessionShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { querySessionShare } from "./querySessionShare.js";
import type { SessionShareRecord } from "./types.js";

export function queryRecoverableSessionShares(tx: TX): readonly SessionShareRecord[] {
    return tx
        .select({ shareId: sessionShares.shareId })
        .from(sessionShares)
        .where(ne(sessionShares.state, "stopped"))
        .orderBy(asc(sessionShares.createdAtMs), asc(sessionShares.shareId))
        .all()
        .map((row) => querySessionShare(tx, row.shareId))
        .filter((share): share is SessionShareRecord => share !== undefined);
}

export function queryStoppedSessionShares(tx: TX): readonly SessionShareRecord[] {
    return tx
        .select({ shareId: sessionShares.shareId })
        .from(sessionShares)
        .where(eq(sessionShares.state, "stopped"))
        .orderBy(asc(sessionShares.stoppedAtMs), asc(sessionShares.shareId))
        .all()
        .map((row) => querySessionShare(tx, row.shareId))
        .filter((share): share is SessionShareRecord => share !== undefined);
}
