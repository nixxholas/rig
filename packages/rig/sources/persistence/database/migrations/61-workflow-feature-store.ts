import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Creates the durable host store consumed by Happy Agent Features workflows. */
export async function workflowFeatureStore(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
            CREATE TABLE workflow_runs (
                agent_id TEXT NOT NULL,
                id TEXT NOT NULL,
                workflow TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                run_json TEXT NOT NULL,
                PRIMARY KEY (agent_id, id)
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE INDEX workflow_runs_agent_status_id
            ON workflow_runs (agent_id, status, id)
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE workflow_logs (
                agent_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                text TEXT NOT NULL,
                PRIMARY KEY (agent_id, run_id, position),
                FOREIGN KEY (agent_id, run_id)
                    REFERENCES workflow_runs (agent_id, id)
                    ON DELETE CASCADE
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE workflow_operation_receipts (
                agent_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                receipt_json TEXT NOT NULL,
                PRIMARY KEY (agent_id, operation_id)
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE workflow_mutation_proofs (
                agent_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                proof_json TEXT NOT NULL,
                PRIMARY KEY (agent_id, operation_id)
            )
        `),
    );
}
