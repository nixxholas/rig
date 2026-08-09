import {
    inspectSessionDatabase,
    type SessionDatabaseInspection,
} from "../../packages/rig/sources/persistence/database/inspectSessionDatabase.js";
import { openSessionDatabase } from "../../packages/rig/sources/persistence/database/openSessionDatabase.js";

export type RigDatabaseInspection = SessionDatabaseInspection;

export async function inspectRigDatabase(
    databasePath: string,
    options: { fullIntegrityCheck?: boolean } = {},
): Promise<RigDatabaseInspection> {
    const opened = await openSessionDatabase(databasePath, { readOnly: true });
    try {
        return await inspectSessionDatabase(opened.database, options);
    } finally {
        await opened.database.close();
    }
}
