import type { Context } from "@steve.kite/stdlib";

import type { Model } from "@slopus/happy-agent-base";
import { eq, sql } from "drizzle-orm";

import type { PermissionMode } from "../../permissions/index.js";
import type { ServiceTier, SessionEvent } from "../../protocol/index.js";
import { sessionCredentialBindings, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";

export async function sessionProjectRigAgentConfiguration(
    ctx: Context,
    input: {
        bindingId: string;
        effort?: string;
        events: readonly SessionEvent[];
        modelChanged: boolean;
        modelId: string;
        models: readonly Model[];
        permissionMode: PermissionMode;
        providerId: string;
        serviceTier?: ServiceTier;
        sessionId: string;
        updatedAt: number;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.session.project_agent_configuration", async (ctx) => {
        const updated = await ctx.tx
            .update(sessions)
            .set({
                effort: input.effort ?? null,
                interrupted: false,
                interruptionJson: null,
                modelId: input.modelId,
                modelsJson: JSON.stringify(input.models),
                permissionMode: input.permissionMode,
                providerId: input.providerId,
                serviceTier: input.serviceTier ?? null,
                ...(input.modelChanged ? { totalTokens: 0 } : {}),
                updatedAtMs: input.updatedAt,
            })
            .where(eq(sessions.id, input.sessionId))
            .run();
        if (updated.rowsAffected === 0) {
            throw new Error(`The conversation '${input.sessionId}' does not exist.`);
        }
        await ctx.tx
            .insert(sessionCredentialBindings)
            .values({ bindingId: input.bindingId, sessionId: input.sessionId })
            .onConflictDoUpdate({
                set: { bindingId: sql`excluded.binding_id` },
                target: sessionCredentialBindings.sessionId,
            })
            .run();
        for (const event of input.events) {
            await sessionAppendEvent(ctx, event, {}, input.updatedAt);
        }
    });
}
