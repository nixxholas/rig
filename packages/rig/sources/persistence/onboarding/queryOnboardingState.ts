import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { onboardingState } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { onboardingStateSchema, type OnboardingState } from "./OnboardingState.js";

export async function queryOnboardingState(tx: DatabaseScope): Promise<OnboardingState> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx
            .select({
                completedVersion: onboardingState.completedVersion,
            })
            .from(onboardingState)
            .where(eq(onboardingState.singleton, 1))
            .get();
        if (row === undefined) throw new Error("The saved onboarding state is missing.");
        const state: unknown = {
            completedVersion: row.completedVersion,
        };
        if (!Value.Check(onboardingStateSchema, state)) {
            throw new Error("The saved onboarding state is invalid.");
        }
        return state;
    });
}
