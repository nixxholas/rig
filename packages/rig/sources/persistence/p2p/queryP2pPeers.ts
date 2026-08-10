import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { asc } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { p2pTrustedPeerSchema, type P2pTrustedPeer } from "../../p2p/P2pPeer.js";
import { p2pPeers } from "../database/schema.js";

export async function queryP2pPeers(ctx: Context): Promise<readonly P2pTrustedPeer[]> {
    return await inDatabase(ctx, "rig.sql.p2p.queryP2pPeers", async (ctx) => {
        const tx = ctx.tx;
        return (await tx.select().from(p2pPeers).orderBy(asc(p2pPeers.instanceId)).all()).map(
            (row) => {
                const bindings: unknown = JSON.parse(row.bindingsJson);
                const connections: unknown = JSON.parse(row.connectionsJson);
                const peer: unknown = {
                    bindings,
                    connections,
                    instanceId: row.instanceId,
                    name: row.name,
                    publicKey: row.publicKey,
                };
                if (!Value.Check(p2pTrustedPeerSchema, peer)) {
                    throw new Error("The saved P2P peer trust is invalid.");
                }
                return peer;
            },
        );
    });
}
