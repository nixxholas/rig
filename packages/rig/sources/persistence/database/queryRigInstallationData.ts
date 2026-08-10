import { lstatSync } from "node:fs";

import { sql } from "drizzle-orm";
import { TransformDecodeCheckError } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { RigInstallationData } from "../../protocol/InstallationProtocol.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    RIG_DATA_IDENTITY_SCHEMA_VERSION,
    SESSION_DATABASE_APPLICATION_ID,
} from "./migrateSessionDatabase.js";
import { inDatabase } from "./inDatabase.js";
import { openSessionDatabase } from "./openSessionDatabase.js";
import { queryRigDataEpochIfPresentInTx } from "./queryRigDataEpoch.js";

/**
 * Queries the authoritative initialization marker without creating or migrating the database.
 * SQLite may create or retain transient `-wal` and `-shm` bookkeeping beside an existing
 * WAL-mode database even though the database connection itself is read-only.
 */
export async function queryRigInstallationData(
    ctx: Context,
    path: string,
    options: {
        openDatabase?: typeof openSessionDatabase;
    } = {},
): Promise<RigInstallationData> {
    try {
        lstatSync(path);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return { status: "absent" };
        return unavailable("unreadable", "Rig data exists but cannot be inspected.");
    }

    let opened: Awaited<ReturnType<typeof openSessionDatabase>>;
    try {
        opened = await (options.openDatabase ?? openSessionDatabase)(ctx, path, { readOnly: true });
    } catch (error) {
        return classifyInspectionError(error);
    }
    try {
        return await inDatabase(opened.ctx, "rig.sql.database.query_installation", async (ctx) => {
            const database = ctx.tx;
            const applicationId =
                (await database.get<{ application_id: number }>(sql.raw("PRAGMA application_id")))
                    ?.application_id ?? 0;
            const schemaVersion =
                (await database.get<{ user_version: number }>(sql.raw("PRAGMA user_version")))
                    ?.user_version ?? 0;
            if (applicationId !== SESSION_DATABASE_APPLICATION_ID) {
                return { status: "uninitialized" };
            }
            if (schemaVersion > 0 && schemaVersion < RIG_DATA_IDENTITY_SCHEMA_VERSION) {
                return {
                    message:
                        "Existing Rig data needs an upgrade before its stable data identity is available.",
                    reason: "pre_identity",
                    schemaVersion,
                    status: "upgrade_required",
                };
            }
            if (schemaVersion < RIG_DATA_IDENTITY_SCHEMA_VERSION) {
                return { status: "uninitialized" };
            }

            if (schemaVersion > CURRENT_SESSION_DATABASE_VERSION) {
                return {
                    ...(await queryFutureEpoch(ctx)),
                    message: `Rig data uses newer schema version ${String(schemaVersion)}; this CLI supports up to ${String(CURRENT_SESSION_DATABASE_VERSION)}. Install a compatible Rig version before starting the daemon.`,
                    reason: "newer_schema",
                    schemaVersion,
                    status: "incompatible",
                };
            }

            const identityTable = (
                await database.all(
                    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rig_data_identity'`,
                )
            )[0];
            if (identityTable === undefined) return damagedData();
            const epoch = await queryRigDataEpochIfPresentInTx(ctx);
            if (epoch === undefined) return damagedData();
            return {
                epoch,
                schemaCompatibility:
                    schemaVersion === CURRENT_SESSION_DATABASE_VERSION
                        ? "current"
                        : "upgrade_required",
                schemaVersion,
                status: "initialized",
            };
        });
    } catch (error) {
        return classifyInspectionError(error);
    } finally {
        await opened.database.close(opened.ctx);
    }
}

async function queryFutureEpoch(ctx: Context): Promise<{
    epoch?: string;
}> {
    try {
        const epoch = await queryRigDataEpochIfPresentInTx(ctx);
        return epoch === undefined ? {} : { epoch };
    } catch {
        return {};
    }
}

function classifyInspectionError(error: unknown): RigInstallationData {
    if (error instanceof TransformDecodeCheckError) return damagedData();
    const code = sqliteErrorCode(error);
    if (code === undefined) {
        return unavailable("unreadable", "Rig data exists but cannot be inspected.");
    }
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

function sqliteErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
        return (error as { code: string }).code;
    }
    if ("cause" in error) return sqliteErrorCode((error as { cause?: unknown }).cause);
    return undefined;
}
