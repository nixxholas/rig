import {
    createDatabaseInspectionContext,
    inspectSessionDatabase,
    type SessionDatabaseInspection,
} from "../../packages/rig/sources/persistence/database/inspectSessionDatabase.js";
import { openSessionDatabase } from "../../packages/rig/sources/persistence/database/openSessionDatabase.js";

export type RigDatabaseInspection = SessionDatabaseInspection;

export async function inspectRigDatabase(
    databasePath: string,
    options: { fullIntegrityCheck?: boolean } = {},
): Promise<RigDatabaseInspection> {
    const opened = await openSessionDatabase(createDatabaseInspectionContext(), databasePath, {
        readOnly: true,
    });
    try {
        return await inspectSessionDatabase(opened.ctx, options);
    } finally {
        await opened.database.close(opened.ctx);
    }
}
