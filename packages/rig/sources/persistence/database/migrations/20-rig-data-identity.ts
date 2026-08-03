import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigDataEpochSchema } from "../../../protocol/InstallationProtocol.js";
import type { SessionDatabase } from "../openSessionDatabase.js";

export function rigDataIdentity(database: SessionDatabase, epoch: string): void {
    epoch = Value.Decode(rigDataEpochSchema, epoch);
    database.run(
        sql.raw(`CREATE TABLE rig_data_identity (
            singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
            epoch TEXT NOT NULL
        )`),
    );
    database.run(sql`INSERT INTO rig_data_identity (singleton, epoch) VALUES (1, ${epoch})`);
}
