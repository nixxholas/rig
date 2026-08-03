import { lstatSync } from "node:fs";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { TransformDecodeCheckError } from "@sinclair/typebox/value";

import type { RigInstallationData } from "../../protocol/InstallationProtocol.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    RIG_DATA_IDENTITY_SCHEMA_VERSION,
    SESSION_DATABASE_APPLICATION_ID,
} from "./migrateSessionDatabase.js";
import { openSessionDatabase } from "./openSessionDatabase.js";
import { queryRigDataEpochIfPresent } from "./queryRigDataEpoch.js";

/**
 * Queries the authoritative initialization marker without creating or migrating the database.
 * SQLite may create or retain transient `-wal` and `-shm` bookkeeping beside an existing
 * WAL-mode database even though the database connection itself is read-only.
 */
export function queryRigInstallationData(
    path: string,
    options: {
        openDatabase?: typeof openSessionDatabase;
    } = {},
): RigInstallationData {
    try {
        lstatSync(path);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return { status: "absent" };
        return unavailable("unreadable", "Rig data exists but cannot be inspected.");
    }

    let opened: ReturnType<typeof openSessionDatabase>;
    try {
        opened = (options.openDatabase ?? openSessionDatabase)(path, { readOnly: true });
    } catch (error) {
        return classifyInspectionError(error);
    }
    try {
        const applicationId = opened.client.pragma("application_id", { simple: true }) as number;
        const schemaVersion = opened.client.pragma("user_version", { simple: true }) as number;
        if (applicationId !== SESSION_DATABASE_APPLICATION_ID) return { status: "uninitialized" };
        if (schemaVersion < RIG_DATA_IDENTITY_SCHEMA_VERSION) {
            return { status: "uninitialized" };
        }

        if (schemaVersion > CURRENT_SESSION_DATABASE_VERSION) {
            return {
                ...queryFutureEpoch(opened.database),
                message: `Rig data uses newer schema version ${String(schemaVersion)}; this CLI supports up to ${String(CURRENT_SESSION_DATABASE_VERSION)}. Install a compatible Rig version before starting the daemon.`,
                reason: "newer_schema",
                schemaVersion,
                status: "incompatible",
            };
        }

        const identityTable = opened.database.get(
            sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rig_data_identity'`,
        );
        if (identityTable === undefined) return damagedData();
        const epoch = queryRigDataEpochIfPresent(opened.database);
        if (epoch === undefined) return damagedData();
        return {
            epoch,
            schemaCompatibility:
                schemaVersion === CURRENT_SESSION_DATABASE_VERSION ? "current" : "upgrade_required",
            schemaVersion,
            status: "initialized",
        };
    } catch (error) {
        return classifyInspectionError(error);
    } finally {
        opened.client.close();
    }
}

function queryFutureEpoch(database: Parameters<typeof queryRigDataEpochIfPresent>[0]): {
    epoch?: string;
} {
    try {
        const epoch = queryRigDataEpochIfPresent(database);
        return epoch === undefined ? {} : { epoch };
    } catch {
        return {};
    }
}

function classifyInspectionError(error: unknown): RigInstallationData {
    if (error instanceof TransformDecodeCheckError) return damagedData();
    if (!(error instanceof Database.SqliteError)) {
        return unavailable("unreadable", "Rig data exists but cannot be inspected.");
    }
    const code = error.code;
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
        return unavailable(
            "busy",
            "Rig data is busy. Try inspection again after current work finishes.",
        );
    }
    if (
        code === "SQLITE_AUTH" ||
        code === "SQLITE_PERM" ||
        code.startsWith("SQLITE_CANTOPEN") ||
        code.startsWith("SQLITE_READONLY")
    ) {
        return unavailable(
            "unreadable",
            "Rig data exists but this CLI does not have permission to inspect it.",
        );
    }
    if (code === "SQLITE_FULL" || code.startsWith("SQLITE_IOERR")) {
        return unavailable(
            "io_error",
            "Rig data could not be inspected because the storage system reported an input/output error.",
        );
    }
    if (
        code.startsWith("SQLITE_CORRUPT") ||
        code === "SQLITE_ERROR" ||
        code === "SQLITE_NOTADB" ||
        code === "SQLITE_SCHEMA"
    ) {
        return damagedData();
    }
    return unavailable("unreadable", "Rig data exists but cannot be inspected.");
}

function damagedData(): RigInstallationData {
    return unavailable(
        "unreadable",
        "Rig data exists but is damaged or is not a Rig database that can be initialized safely.",
    );
}

function unavailable(
    reason: "busy" | "io_error" | "unreadable",
    message: string,
): RigInstallationData {
    return { message, reason, status: "unavailable" };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}
