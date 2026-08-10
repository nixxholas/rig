import { eq } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";

import { onboardingState } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { onboardingVersionSchema, type OnboardingVersion } from "./OnboardingState.js";
import { queryOnboardingState } from "./queryOnboardingState.js";

/** Stores completion monotonically, so an older caller cannot reopen onboarding. */
export async function onboardingMarkCompleted(
    ctx: Context,
    completedVersion: OnboardingVersion,
): Promise<boolean> {
    if (!Value.Check(onboardingVersionSchema, completedVersion)) {
        throw new Error("The onboarding completion version is invalid.");
    }
    return await inTx(ctx, "rig.sql.onboarding.mark_completed", async (ctx) => {
        const transaction = ctx.tx;
        const current = await queryOnboardingState(ctx);
        if (current.completedVersion >= completedVersion) return false;
        const result = await transaction
            .update(onboardingState)
            .set({ completedVersion })
            .where(eq(onboardingState.singleton, 1))
            .run();
        if (result.rowsAffected !== 1) throw new Error("The saved onboarding state is missing.");
        return true;
    });
}
