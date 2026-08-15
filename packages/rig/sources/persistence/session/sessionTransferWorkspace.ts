import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { replaceContextMessages } from "./sessionSave.js";
import type { SessionWorkspaceTransferState } from "../../session/sessionWorkspaceTransferState.js";
import { sessionScopeValues } from "./impl/sessionScope.js";

export async function sessionTransferWorkspace(
    ctx: Context,
    input: {
        contextMessages: readonly Message[];
        cwd: string;
        now: number;
        orderKey: string;
        projectId: string;
        sessionId: string;
        state: SessionWorkspaceTransferState;
        workspaceId: string;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_transfer_workspace", async (ctx) => {
        const tx = ctx.tx;
        const changed = (
            await tx
                .update(sessions)
                .set({
                    ...sessionScopeValues({
                        kind: "workspace",
                        projectId: input.projectId,
                        workspaceId: input.workspaceId,
                    }),
                    cwd: input.cwd,
                    orderKey: input.orderKey,
                    unsortedSinceMs: null,
                    updatedAtMs: input.now,
                    workspaceId: input.workspaceId,
                    workspaceTransferJson: JSON.stringify(input.state),
                })
                .where(eq(sessions.id, input.sessionId))
                .run()
        ).rowsAffected;
        if (changed === 0) throw new Error("The session is no longer available.");

        await replaceContextMessages(ctx, input.sessionId, input.contextMessages);
    });
}
