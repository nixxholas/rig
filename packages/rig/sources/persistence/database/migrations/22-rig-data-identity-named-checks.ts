import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function rigDataIdentityNamedChecks(database: SessionDatabase): void {
    database.run(
        sql.raw(`CREATE TABLE rig_data_identity_next (
            singleton INTEGER NOT NULL PRIMARY KEY
                CONSTRAINT rig_data_identity_singleton CHECK (singleton = 1),
            epoch TEXT NOT NULL,
            format_version INTEGER NOT NULL DEFAULT 1
                CONSTRAINT rig_data_identity_format_version CHECK (format_version = 1)
        )`),
    );
    database.run(
        sql.raw(`INSERT INTO rig_data_identity_next (singleton, epoch, format_version)
            SELECT singleton, epoch, format_version FROM rig_data_identity`),
    );
    database.run(sql.raw("DROP TABLE rig_data_identity"));
    database.run(sql.raw("ALTER TABLE rig_data_identity_next RENAME TO rig_data_identity"));
}
