import type { TX } from "./Transaction.js";

export function inTx<T>(tx: TX, operation: (tx: TX) => T): T {
    if ("rollback" in tx) return operation(tx);
    return tx.transaction((transaction) => operation(transaction), { behavior: "immediate" });
}
