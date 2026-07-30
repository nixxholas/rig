import { sql } from "drizzle-orm";

import { queuedRuns } from "../database/schema.js";
import type { PersistedQueuedRun } from "../../server/InMemorySession.js";
import type { TX } from "../Transaction.js";

export function sessionSaveQueuedRun(
    tx: TX,
    sessionId: string,
    run: PersistedQueuedRun,
    createdAt: number,
): void {
    const integrationConfigJson =
        run.effort === undefined &&
        run.externalTools === undefined &&
        run.modelId === undefined &&
        run.providerId === undefined &&
        run.serviceTier === undefined &&
        run.skills === undefined &&
        run.systemPrompt === undefined
            ? null
            : JSON.stringify({
                  ...(run.externalTools === undefined ? {} : { externalTools: run.externalTools }),
                  ...(run.skills === undefined ? {} : { skills: run.skills }),
                  ...(run.effort === undefined ? {} : { effort: run.effort }),
                  ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
                  ...(run.providerId === undefined ? {} : { providerId: run.providerId }),
                  ...(run.serviceTier === undefined ? {} : { serviceTier: run.serviceTier }),
                  ...(run.systemPrompt === undefined ? {} : { systemPrompt: run.systemPrompt }),
              });
    tx.insert(queuedRuns)
        .values({
            createdAtMs: createdAt,
            debug: run.debug === true,
            debugDirectory: run.debugDirectory ?? null,
            displayText: run.displayText,
            integrationConfigJson,
            kind: run.kind,
            runId: run.runId,
            sessionId,
            text: run.text,
            userMessageJson: JSON.stringify(run.userMessage),
        })
        .onConflictDoUpdate({
            set: {
                debug: sql`excluded.debug`,
                debugDirectory: sql`excluded.debug_directory`,
                displayText: sql`excluded.display_text`,
                integrationConfigJson: sql`excluded.integration_config_json`,
                kind: sql`excluded.kind`,
                text: sql`excluded.text`,
                userMessageJson: sql`excluded.user_message_json`,
            },
            target: [queuedRuns.sessionId, queuedRuns.runId],
        })
        .run();
}
