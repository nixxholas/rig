import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { onboardingState } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { onboardingStateSchema, type OnboardingState } from "./OnboardingState.js";

export function queryOnboardingState(tx: TX): OnboardingState {
    const row = tx
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
}
