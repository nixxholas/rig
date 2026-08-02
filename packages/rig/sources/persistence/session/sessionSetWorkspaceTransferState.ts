import { eq } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import type { SessionWorkspaceTransferState } from "../../session/sessionWorkspaceTransferState.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { replaceContextMessages } from "./sessionSave.js";

export function sessionSetWorkspaceTransferState(
    tx: TX,
    input: {
        contextMessages?: readonly Message[];
        now: number;
        sessionId: string;
        state: SessionWorkspaceTransferState;
    },
): void {
    inTx(tx, (tx) => {
        const changed = tx
            .update(sessions)
            .set({
                updatedAtMs: input.now,
                workspaceTransferJson: JSON.stringify(input.state),
            })
            .where(eq(sessions.id, input.sessionId))
            .run().changes;
        if (changed === 0) throw new Error("The session is no longer available.");
        if (input.contextMessages !== undefined) {
            replaceContextMessages(tx, input.sessionId, input.contextMessages);
        }
    });
}
