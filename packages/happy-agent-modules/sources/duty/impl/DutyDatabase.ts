import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { DutyBinding, DutyRun } from "../Duty.js";

const DUTY_STATE_TABLE = "happy_agent_duty_state";
const DUTY_RUN_TABLE = "happy_agent_duty_runs";

export class DutyDatabase {
    async binding(ctx: Context, agentId: string): Promise<unknown> {
        const rows = await agentDatabaseRows<{ value_json: string }>(
            ctx.db,
            sql`SELECT value_json FROM ${sql.raw(DUTY_STATE_TABLE)}
                WHERE agent_id = ${agentId} LIMIT 1`,
        );
        return decode(rows[0]?.value_json);
    }

    /** Every binding this machine holds, so a restart can re-arm what the last process was doing. */
    async bindings(ctx: Context): Promise<readonly unknown[]> {
        const rows = await agentDatabaseRows<{ value_json: string }>(
            ctx.db,
            sql`SELECT value_json FROM ${sql.raw(DUTY_STATE_TABLE)} ORDER BY agent_id`,
        );
        return rows.map((row) => decode(row.value_json));
    }

    async writeBinding(ctx: Context, binding: DutyBinding): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(DUTY_STATE_TABLE)} (agent_id, value_json)
                VALUES (${binding.agentId}, ${encode(binding)})
                ON CONFLICT (agent_id) DO UPDATE SET value_json = EXCLUDED.value_json`,
        );
    }

    async run(ctx: Context, runId: string): Promise<unknown> {
        const rows = await agentDatabaseRows<{ value_json: string }>(
            ctx.db,
            sql`SELECT value_json FROM ${sql.raw(DUTY_RUN_TABLE)} WHERE run_id = ${runId} LIMIT 1`,
        );
        return decode(rows[0]?.value_json);
    }

    async writeRun(ctx: Context, run: DutyRun): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(DUTY_RUN_TABLE)}
                    (run_id, agent_id, created_at, value_json)
                VALUES (${run.runId}, ${run.agentId}, ${run.createdAt}, ${encode(run)})
                ON CONFLICT (run_id) DO UPDATE SET
                    created_at = EXCLUDED.created_at,
                    value_json = EXCLUDED.value_json`,
        );
    }

    async runs(ctx: Context, agentId: string): Promise<readonly unknown[]> {
        const rows = await agentDatabaseRows<{ value_json: string }>(
            ctx.db,
            sql`SELECT value_json FROM ${sql.raw(DUTY_RUN_TABLE)}
                WHERE agent_id = ${agentId} ORDER BY created_at, run_id`,
        );
        return rows.map((row) => decode(row.value_json));
    }
}

function encode(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Duty state cannot persist undefined.");
    return encoded;
}

function decode(value: string | undefined): unknown {
    return value === undefined ? undefined : JSON.parse(value);
}
