import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { SessionWorkspaceTransferState } from "../../session/sessionWorkspaceTransferState.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import { replaceContextMessages } from "./sessionSave.js";

export async function sessionSetWorkspaceTransferState(
    ctx: Context,
    input: {
        contextMessages?: readonly Message[];
        now: number;
        sessionId: string;
        state: SessionWorkspaceTransferState;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_set_workspace_transfer_state", async (ctx) => {
        const tx = ctx.tx;
        const changed = (
            await tx
                .update(sessions)
                .set({
                    updatedAtMs: input.now,
                    workspaceTransferJson: JSON.stringify(input.state),
                })
                .where(eq(sessions.id, input.sessionId))
                .run()
        ).rowsAffected;
        if (changed === 0) throw new Error("The session is no longer available.");
        if (input.contextMessages !== undefined) {
            await replaceContextMessages(ctx, input.sessionId, input.contextMessages);
        }
    });
}
