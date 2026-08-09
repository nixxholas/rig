import type { ExternalToolCall } from "../../external-tools/index.js";
import type { DurableUserInputCall } from "../../user-input/index.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import { durableUserInputSave } from "./durableUserInputSave.js";
import { externalToolCallSave } from "./externalToolCallSave.js";

export async function durablePermissionHandoff(
    tx: DatabaseScope,
    externalCall: ExternalToolCall,
    permissionCall: DurableUserInputCall,
): Promise<void> {
    await inTx(tx, async (tx) => {
        await externalToolCallSave(tx, externalCall);
        await durableUserInputSave(tx, permissionCall);
    });
}
