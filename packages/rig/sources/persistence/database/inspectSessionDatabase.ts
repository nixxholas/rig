import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { createRootContext, type Context, type RootContext } from "@steve.kite/stdlib";

import { inDatabase } from "./inDatabase.js";
import { projectWorkspaces, projects, sessionEvents, sessionMessages, sessions } from "./schema.js";

export interface SessionDatabaseInspection {
    counts: {
        activeProjects: number;
        activeRootSessions: number;
        activeWorkspaces: number;
        projects: number;
        rootSessions: number;
        sessionEvents: number;
        sessionMessages: number;
        sessions: number;
        workspaces: number;
    };
    foreignKeyViolations: number;
    integrity: string;
    invalidJsonRows: number;
    schemaVersion: number;
}

/** Creates the isolated context used by the read-only database inspection CLI. */
export function createDatabaseInspectionContext(): RootContext {
    return createRootContext();
}

export async function inspectSessionDatabase(
    ctx: Context,
    options: { fullIntegrityCheck?: boolean } = {},
): Promise<SessionDatabaseInspection> {
    return await inDatabase(ctx, "rig.sql.database.inspect", async (ctx) => {
        const connection = ctx.tx;
        const integrityPragma =
            options.fullIntegrityCheck === true ? "integrity_check" : "quick_check";
        const integrityRow = await connection.get<Record<string, unknown>>(
            sql.raw(`PRAGMA ${integrityPragma}(1)`),
        );
        const foreignKeyViolations =
            (
                await connection.get<{ count: number }>(
                    sql.raw("SELECT COUNT(*) AS count FROM pragma_foreign_key_check"),
                )
            )?.count ?? 0;
        const invalidJsonRows =
            (
                await connection.get<{ count: number }>(
                    sql.raw(`
                    SELECT
                        (SELECT COUNT(*) FROM session_events WHERE NOT json_valid(data_json)) +
                        (SELECT COUNT(*) FROM session_messages WHERE NOT json_valid(message_json)) +
                        (SELECT COUNT(*) FROM sessions WHERE NOT json_valid(models_json)) +
                        (SELECT COUNT(*) FROM sessions WHERE NOT json_valid(tools_json))
                        AS count
                `),
                )
            )?.count ?? 0;

        return {
            counts: {
                activeProjects: selectCount(
                    await connection
                        .select({ value: count() })
                        .from(projects)
                        .where(isNull(projects.archivedAtMs))
                        .get(),
                ),
                activeRootSessions: selectCount(
                    await connection
                        .select({ value: count() })
                        .from(sessions)
                        .where(and(isNull(sessions.parentSessionId), eq(sessions.archived, false)))
                        .get(),
                ),
                activeWorkspaces: selectCount(
                    await connection
                        .select({ value: count() })
                        .from(projectWorkspaces)
                        .innerJoin(projects, eq(projects.id, projectWorkspaces.projectId))
                        .where(
                            and(
                                isNull(projects.archivedAtMs),
                                isNull(projectWorkspaces.archivedAtMs),
                                ne(projectWorkspaces.status, "archived"),
                            ),
                        )
                        .get(),
                ),
                projects: selectCount(
                    await connection.select({ value: count() }).from(projects).get(),
                ),
                rootSessions: selectCount(
                    await connection
                        .select({ value: count() })
                        .from(sessions)
                        .where(isNull(sessions.parentSessionId))
                        .get(),
                ),
                sessionEvents: selectCount(
                    await connection.select({ value: count() }).from(sessionEvents).get(),
                ),
                sessionMessages: selectCount(
                    await connection.select({ value: count() }).from(sessionMessages).get(),
                ),
                sessions: selectCount(
                    await connection.select({ value: count() }).from(sessions).get(),
                ),
                workspaces: selectCount(
                    await connection.select({ value: count() }).from(projectWorkspaces).get(),
                ),
            },
            foreignKeyViolations,
            integrity: readString(integrityRow, integrityPragma),
            invalidJsonRows,
            schemaVersion:
                (await connection.get<{ user_version: number }>(sql.raw("PRAGMA user_version")))
                    ?.user_version ?? 0,
        };
    });
}

function selectCount(row: { value: number } | undefined): number {
    return row?.value ?? 0;
}

function readString(row: Record<string, unknown> | undefined, key: string): string {
    const value = row?.[key];
    if (typeof value !== "string") {
        throw new Error(`The database did not return a text ${key}.`);
    }
    return value;
}
