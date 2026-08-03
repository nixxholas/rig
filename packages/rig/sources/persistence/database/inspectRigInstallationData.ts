import { existsSync } from "node:fs";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { TransformDecodeCheckError } from "@sinclair/typebox/value";

import type { RigInstallationData } from "../../protocol/InstallationProtocol.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    SESSION_DATABASE_APPLICATION_ID,
} from "./migrateSessionDatabase.js";
import { openSessionDatabase } from "./openSessionDatabase.js";
import { queryRigDataEpochIfPresent } from "./queryRigDataEpoch.js";

/**
 * Reads the authoritative initialization marker without creating, migrating, or otherwise
 * changing the database. A present database becomes initialized only after the identity migration
 * commits; older, foreign, and empty SQLite files are uninitialized until normal daemon startup.
 */
export function inspectRigInstallationData(path: string): RigInstallationData {
    if (!existsSync(path)) return { status: "absent" };

    let opened: ReturnType<typeof openSessionDatabase>;
    try {
        opened = openSessionDatabase(path, { readOnly: true });
    } catch (error) {
        if (isUninitializedDataError(error)) return { status: "uninitialized" };
        throw error;
    }
    try {
        const applicationId = opened.client.pragma("application_id", { simple: true }) as number;
        const schemaVersion = opened.client.pragma("user_version", { simple: true }) as number;
        if (
            applicationId !== SESSION_DATABASE_APPLICATION_ID ||
            schemaVersion !== CURRENT_SESSION_DATABASE_VERSION
        ) {
            return { status: "uninitialized" };
        }
        const identityTable = opened.database.get(
            sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rig_data_identity'`,
        );
        if (identityTable === undefined) return { status: "uninitialized" };
        const epoch = queryRigDataEpochIfPresent(opened.database);
        if (epoch === undefined) return { status: "uninitialized" };
        return {
            epoch,
            status: "initialized",
        };
    } catch (error) {
        if (isUninitializedDataError(error)) return { status: "uninitialized" };
        throw error;
    } finally {
        opened.client.close();
    }
}

function isUninitializedDataError(error: unknown): boolean {
    if (error instanceof TransformDecodeCheckError) return true;
    return (
        error instanceof Database.SqliteError &&
        ["SQLITE_CORRUPT", "SQLITE_ERROR", "SQLITE_NOTADB", "SQLITE_SCHEMA"].includes(error.code)
    );
}
