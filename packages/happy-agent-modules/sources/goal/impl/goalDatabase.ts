import { sql } from "drizzle-orm";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

const GOAL_STATE_TABLE = "happy_agent_goal_state";

/**
 * The Goal module's database-backed per-agent key/value view.
 *
 * This is intentionally private to Goal. It has the tiny surface needed by the
 * state helpers, while the table and its migration remain owned by the module.
 * The host supplies the active Drizzle facade through AgentModuleScope.
 */
export class GoalDatabase {
    readonly #database: AgentDatabase;
    readonly #agentId: string;

    constructor(database: AgentDatabaseFacade<AgentDatabase>, agentId: string) {
        this.#database = database;
        this.#agentId = agentId;
    }

    async read(ctx: Context, key: string): Promise<unknown> {
        void ctx;
        const rows = await agentDatabaseRows<{ value_json: string }>(
            this.#database,
            sql`SELECT value_json
                FROM ${sql.raw(GOAL_STATE_TABLE)}
                WHERE agent_id = ${this.#agentId} AND state_key = ${key}
                LIMIT 1`,
        );
        const value = rows[0]?.value_json;
        return value === undefined ? undefined : JSON.parse(value);
    }

    async write(ctx: Context, key: string, value: unknown): Promise<void> {
        void ctx;
        const encoded = JSON.stringify(value);
        if (encoded === undefined) {
            throw new Error("Goal state cannot persist undefined.");
        }
        await agentDatabaseRun(
            this.#database,
            sql`INSERT INTO ${sql.raw(GOAL_STATE_TABLE)}
                    (agent_id, state_key, value_json)
                VALUES (${this.#agentId}, ${key}, ${encoded})
                ON CONFLICT (agent_id, state_key)
                DO UPDATE SET value_json = EXCLUDED.value_json`,
        );
    }

    async delete(ctx: Context, key: string): Promise<void> {
        void ctx;
        await agentDatabaseRun(
            this.#database,
            sql`DELETE FROM ${sql.raw(GOAL_STATE_TABLE)}
                WHERE agent_id = ${this.#agentId} AND state_key = ${key}`,
        );
    }

    /**
     * Agent Base has already opened the transaction for a module hook. Public
     * operations enter the host transaction before constructing this view, so
     * this method deliberately does not open a second transaction.
     */
    async transaction<Result>(
        ctx: Context,
        work: (store: GoalDatabase, txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await work(this, ctx);
    }
}

export type GoalDatabaseFacade = GoalDatabase;
