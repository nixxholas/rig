import type { Context } from "@steve.kite/stdlib";

import type { ExternalToolCall } from "../../external-tools/index.js";
import type { DurableUserInputCall } from "../../user-input/index.js";
import { inTx } from "../inTx.js";
import { durableUserInputSave } from "./durableUserInputSave.js";
import { externalToolCallSave } from "./externalToolCallSave.js";

export async function durablePermissionHandoff(
    ctx: Context,
    externalCall: ExternalToolCall,
    permissionCall: DurableUserInputCall,
): Promise<void> {
    await inTx(ctx, "rig.sql.session.durable_permission_handoff", async (ctx) => {
        await externalToolCallSave(ctx, externalCall);
        await durableUserInputSave(ctx, permissionCall);
    });
}
