import { eq } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { replaceContextMessages } from "./sessionSave.js";
import type { SessionWorkspaceTransferState } from "../../session/sessionWorkspaceTransferState.js";

export function sessionTransferWorkspace(
    tx: TX,
    input: {
        contextMessages: readonly Message[];
        cwd: string;
        now: number;
        sessionId: string;
        state: SessionWorkspaceTransferState;
        workspaceId: string;
    },
): void {
    inTx(tx, (tx) => {
        const changed = tx
            .update(sessions)
            .set({
                cwd: input.cwd,
                updatedAtMs: input.now,
                workspaceId: input.workspaceId,
                workspaceTransferJson: JSON.stringify(input.state),
            })
            .where(eq(sessions.id, input.sessionId))
            .run().changes;
        if (changed === 0) throw new Error("The session is no longer available.");

        replaceContextMessages(tx, input.sessionId, input.contextMessages);
    });
}
