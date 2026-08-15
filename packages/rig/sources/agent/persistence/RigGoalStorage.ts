import type { GoalPersistence, GoalStorage } from "@slopus/happy-agent-features";

import type { SessionDatabase } from "../../persistence/database/SessionDatabase.js";
import { SqliteAgentPersistence } from "./SqliteAgentPersistence.js";

/**
 * Adapts Agent Base's untyped KV persistence to Goal's deliberately narrow,
 * runtime-validated value contract.
 */
export class RigGoalStorage implements GoalStorage {
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase) {
        this.#database = database;
    }

    persistence(agentId: string): GoalPersistence {
        const persistence = new SqliteAgentPersistence(this.#database, agentId);
        return {
            transaction: async (ctx, work) => await persistence.transaction(ctx, work),
            readValues: async (ctx, prefix) => {
                const entries = await persistence.readValues(ctx, prefix);
                return entries.map(({ key, value }) => ({ key, value })) as Awaited<
                    ReturnType<GoalPersistence["readValues"]>
                >;
            },
            writeValue: async (ctx, key, value) => {
                await persistence.writeValue(ctx, key, value);
            },
            writeValueIfAbsent: async (ctx, key, value) =>
                await persistence.writeValueIfAbsent(ctx, key, value),
            deleteValue: async (ctx, key) => {
                await persistence.deleteValue(ctx, key);
            },
        };
    }
}
