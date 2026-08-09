import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

/** Durable, local facts that let onboarding avoid repeating completed work. */
export function onboardingState(database: SessionDatabase): void {
    database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS onboarding_state (
                singleton INTEGER NOT NULL PRIMARY KEY
                    CONSTRAINT onboarding_state_singleton CHECK (singleton = 1),
                completed_version INTEGER NOT NULL DEFAULT 0
                    CONSTRAINT onboarding_state_completed_version CHECK (completed_version >= 0)
            )
        `),
    );
    database.run(
        sql.raw(
            "INSERT INTO onboarding_state (singleton) VALUES (1) ON CONFLICT (singleton) DO NOTHING",
        ),
    );
}
