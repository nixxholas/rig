import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * Replaces the legacy process-manager catalog with the durable catalog owned by
 * Happy Agent Features. Worklets are an early-stage clean replacement, so old
 * catalog metadata is deliberately discarded instead of translated.
 */
export async function workletFeatureCatalog(database: SessionDatabase): Promise<void> {
    await database.run(sql.raw("DROP TABLE IF EXISTS worklet_versions"));
    await database.run(sql.raw("DROP TABLE IF EXISTS worklets"));
    await database.run(sql.raw("DROP TABLE IF EXISTS worklet_mutation_receipts"));
    await database.run(sql.raw("DROP TABLE IF EXISTS worklet_mutation_proofs"));
    await database.run(
        sql.raw(`
            CREATE TABLE worklets (
                name TEXT NOT NULL PRIMARY KEY,
                owner_agent_id TEXT NOT NULL,
                current_version INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE worklet_versions (
                worklet_name TEXT NOT NULL,
                version INTEGER NOT NULL,
                source_ref TEXT NOT NULL,
                change_description TEXT NOT NULL,
                operations_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                operation_id TEXT NOT NULL UNIQUE,
                PRIMARY KEY (worklet_name, version),
                FOREIGN KEY (worklet_name)
                    REFERENCES worklets (name)
                    ON DELETE CASCADE
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE worklet_mutation_receipts (
                operation_id TEXT NOT NULL PRIMARY KEY,
                receipt_json TEXT NOT NULL
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE worklet_mutation_proofs (
                operation_id TEXT NOT NULL PRIMARY KEY,
                proof_json TEXT NOT NULL
            )
        `),
    );
}