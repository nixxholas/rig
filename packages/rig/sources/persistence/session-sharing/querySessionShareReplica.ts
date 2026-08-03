import { asc, eq } from "drizzle-orm";

import { sessionShareReplicaEntries, sessionShareReplicas } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { SessionShareReplicaRecord } from "./types.js";

export function querySessionShareReplica(
    tx: TX,
    shareId: string,
): SessionShareReplicaRecord | undefined {
    const row = tx
        .select()
        .from(sessionShareReplicas)
        .where(eq(sessionShareReplicas.shareId, shareId))
        .get();
    return row === undefined
        ? undefined
        : {
              createdAt: row.createdAtMs,
              ...(row.endedAtMs === null ? {} : { endedAt: row.endedAtMs }),
              ...(row.endedReason === null ? {} : { endedReason: row.endedReason }),
              grantEpoch: row.grantEpoch,
              memberCount: row.memberCount,
              murmurPeerId: row.murmurPeerId,
              ownerPeerId: row.ownerPeerId,
              shareId: row.shareId,
              shareMemberId: row.shareMemberId,
              state: row.state as SessionShareReplicaRecord["state"],
              title: row.title,
              updatedAt: row.updatedAtMs,
          };
}

export function querySessionShareReplicaEntries(tx: TX, shareId: string) {
    return tx
        .select()
        .from(sessionShareReplicaEntries)
        .where(eq(sessionShareReplicaEntries.shareId, shareId))
        .orderBy(asc(sessionShareReplicaEntries.sequence))
        .all()
        .map((row) => ({
            canonicalJson: row.canonicalJson,
            contentHash: row.contentHash,
            createdAt: row.createdAtMs,
            grantEpoch: row.grantEpoch,
            grantMemberId: row.grantMemberId,
            sequence: row.sequence,
            shareEventId: row.shareEventId,
            shareId: row.shareId,
        }));
}

export function querySessionShareReplicas(tx: TX): readonly SessionShareReplicaRecord[] {
    return tx
        .select({ shareId: sessionShareReplicas.shareId })
        .from(sessionShareReplicas)
        .orderBy(asc(sessionShareReplicas.updatedAtMs), asc(sessionShareReplicas.shareId))
        .all()
        .map((row) => querySessionShareReplica(tx, row.shareId))
        .filter((replica): replica is SessionShareReplicaRecord => replica !== undefined);
}
