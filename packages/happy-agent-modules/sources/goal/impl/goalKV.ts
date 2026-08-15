import type {
    AgentDatabase,
    AgentDatabaseFacade,
} from "@slopus/happy-agent-base";

import { GoalDatabase } from "./goalDatabase.js";

/** The module-owned per-agent database view used by public operations and hooks. */
export function goalKV(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
): GoalDatabase {
    return new GoalDatabase(database, agentId);
}