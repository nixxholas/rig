import { type AgentDatabase, type AgentDatabaseFacade } from "@slopus/happy-agent-base";

import { TaskDatabase } from "./taskDatabase.js";

/** The module's per-agent database view, shared by public methods and agent hooks. */
export function taskKV(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
): TaskDatabase {
    return new TaskDatabase(database, agentId);
}
