import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { onboardingState } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { inTx } from "../inTx.js";
import { onboardingVersionSchema, type OnboardingVersion } from "./OnboardingState.js";
import { queryOnboardingState } from "./queryOnboardingState.js";

/** Stores completion monotonically, so an older caller cannot reopen onboarding. */
export function onboardingMarkCompleted(tx: TX, completedVersion: OnboardingVersion): boolean {
    if (!Value.Check(onboardingVersionSchema, completedVersion)) {
        throw new Error("The onboarding completion version is invalid.");
    }
    return inTx(tx, (transaction) => {
        const current = queryOnboardingState(transaction);
        if (current.completedVersion >= completedVersion) return false;
        const result = transaction
            .update(onboardingState)
            .set({ completedVersion })
            .where(eq(onboardingState.singleton, 1))
            .run();
        if (result.changes !== 1) throw new Error("The saved onboarding state is missing.");
        return true;
    });
}
