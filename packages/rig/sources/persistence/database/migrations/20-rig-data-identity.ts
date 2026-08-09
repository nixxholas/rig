import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigDataEpochSchema } from "../../../protocol/InstallationProtocol.js";
import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function rigDataIdentity(database: SessionDatabase, epoch: string): Promise<void> {
    epoch = Value.Decode(rigDataEpochSchema, epoch);
    await database.run(
        sql.raw(`CREATE TABLE rig_data_identity (
            singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
            epoch TEXT NOT NULL
        )`),
    );
    await database.run(sql`INSERT INTO rig_data_identity (singleton, epoch) VALUES (1, ${epoch})`);
}
