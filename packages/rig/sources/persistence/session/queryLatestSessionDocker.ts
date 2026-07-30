import { sql } from "drizzle-orm";

import type { DockerExecutionConfig } from "../../execution/index.js";
import type { TX } from "../Transaction.js";
import { readOptionalString } from "./impl/sqliteRow.js";

export function queryLatestSessionDocker(
    tx: TX,
    projectId: string,
    workspaceId: string | undefined,
): DockerExecutionConfig | undefined {
    const row =
        workspaceId === undefined
            ? tx.get<Record<string, unknown>>(sql`
                  SELECT docker_json FROM sessions
                  WHERE project_id = ${projectId}
                      AND workspace_id IS NULL
                      AND parent_session_id IS NULL
                  ORDER BY updated_at_ms DESC, id DESC LIMIT 1
              `)
            : tx.get<Record<string, unknown>>(sql`
                  SELECT docker_json FROM sessions
                  WHERE project_id = ${projectId}
                      AND workspace_id = ${workspaceId}
                      AND parent_session_id IS NULL
                  ORDER BY updated_at_ms DESC, id DESC LIMIT 1
              `);
    const value = row === undefined ? undefined : readOptionalString(row, "docker_json");
    return value === undefined ? undefined : (JSON.parse(value) as DockerExecutionConfig);
}
