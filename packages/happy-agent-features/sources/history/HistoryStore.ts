import type { Context } from "@steve.kite/stdlib";

import type { HistoryMessage } from "./HistoryMessage.js";

/** One stored message and where it sits in the agent's whole history. */
export interface HistoryRecord {
    /** The message as it was recorded. */
    readonly message: HistoryMessage;
    /**
     * The message's zero-based place in everything the agent has ever recorded. It is what a
     * cursor names, so it must stay the same for a given message even after older ones are
     * dropped — a reader continuing from a cursor must not silently skip or repeat.
     */
    readonly position: number;
}

/**
 * Where an agent's history is kept.
 *
 * The feature records and reads; the store decides what durable means. The default store keeps
 * history in the agent's own key-value space, and a host with a real archive — Rig's session
 * transcript, a database, a log service — implements this instead and keeps everything else.
 *
 * A store is written to from inside the transaction that commits the work being recorded, so an
 * implementation that writes elsewhere should expect to be called there and must not assume it
 * can take its time.
 */
export interface HistoryStore {
    /** Add messages to the end of an agent's history, in the order given. */
    append(ctx: Context, agentId: string, messages: readonly HistoryMessage[]): Promise<void>;
    /** Everything the agent's history holds, oldest first. */
    read(ctx: Context, agentId: string): Promise<readonly HistoryRecord[]>;
}
