import type { DatabaseSync } from "node:sqlite";

import type { SessionDatabaseMigration } from "../SessionDatabaseMigration.js";

const VERSION = 12;
const BATCH_SIZE = 4_096;

export const migration12: SessionDatabaseMigration = {
    version: VERSION,
    prepare(database) {
        database
            .prepare(
                `
                INSERT OR IGNORE INTO session_database_migrations (
                    version, cursor, completed
                ) VALUES (?, 0, 0)
                `,
            )
            .run(VERSION);
    },
    apply(database) {
        const readProgress = database.prepare(
            `
            SELECT cursor
            FROM session_database_migrations
            WHERE version = ? AND completed = 0
            `,
        );
        const nextBatchEnd = database.prepare(`
            SELECT MAX(rowid) AS last_rowid
            FROM (
                SELECT rowid
                FROM session_messages
                WHERE rowid > ?
                ORDER BY rowid
                LIMIT ?
            )
        `);
        const insertBatch = database.prepare(`
            INSERT INTO session_turns (session_id, run_id, first_position)
            SELECT session_id, run_id, MIN(position)
            FROM session_messages
            WHERE rowid > ? AND rowid <= ?
                AND run_id IS NOT NULL
                AND is_partial = 0
            GROUP BY session_id, run_id
            ON CONFLICT(session_id, run_id) DO UPDATE SET
                first_position = MIN(session_turns.first_position, excluded.first_position)
        `);
        const advance = database.prepare(
            `
            UPDATE session_database_migrations
            SET cursor = ?
            WHERE version = ? AND cursor = ? AND completed = 0
            `,
        );
        const complete = database.prepare(
            "UPDATE session_database_migrations SET completed = 1 WHERE version = ?",
        );

        while (true) {
            const progress = readProgress.get(VERSION);
            if (progress === undefined) return;
            const cursor = readNumber(progress, "cursor");
            const batchEnd = readOptionalNumber(nextBatchEnd.get(cursor, BATCH_SIZE), "last_rowid");
            if (batchEnd === undefined) {
                complete.run(VERSION);
                return;
            }

            database.exec("BEGIN IMMEDIATE");
            try {
                insertBatch.run(cursor, batchEnd);
                const advanced = advance.run(batchEnd, VERSION, cursor);
                if (Number(advanced.changes) !== 1) {
                    throw new Error("Session database migration 12 changed concurrently.");
                }
                database.exec("COMMIT");
            } catch (error) {
                try {
                    database.exec("ROLLBACK");
                } catch {
                    // Keep the failed migration batch as the actionable startup error.
                }
                throw error;
            }
        }
    },
};

function readNumber(row: unknown, column: string): number {
    if (row === null || typeof row !== "object") {
        throw new Error(`Expected migration column ${column}.`);
    }
    const value = (row as Record<string, unknown>)[column];
    if (typeof value !== "number" && typeof value !== "bigint") {
        throw new Error(`Expected migration column ${column} to be numeric.`);
    }
    return Number(value);
}

function readOptionalNumber(row: unknown, column: string): number | undefined {
    if (row === null || typeof row !== "object") return undefined;
    const value = (row as Record<string, unknown>)[column];
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "number" && typeof value !== "bigint") {
        throw new Error(`Expected migration column ${column} to be numeric.`);
    }
    return Number(value);
}
