import type { ExternalToolCall } from "../../external-tools/index.js";
import type { DurableUserInputCall } from "../../user-input/index.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { durableUserInputSave } from "./durableUserInputSave.js";
import { externalToolCallSave } from "./externalToolCallSave.js";

export function durablePermissionHandoff(
    tx: TX,
    externalCall: ExternalToolCall,
    permissionCall: DurableUserInputCall,
): void {
    inTx(tx, (tx) => {
        externalToolCallSave(tx, externalCall);
        durableUserInputSave(tx, permissionCall);
    });
}
