import type {
    SessionAssistantBlock,
    SessionMessage,
    SessionSystemMessage,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

/**
 * One record of the main context store. Only content that is part of the model context lives
 * here: user messages enter when a turn consumes them, assistant output is appended one finished
 * block at a time, and tool results follow the blocks that called them, so records always arrive
 * in context order and consecutive block records reassemble into one assistant message. A
 * compaction record carries the complete replacement context — the messages that stay — and is
 * written in the same transaction that physically deletes the superseded records, so it opens
 * the store; the records after it append as usual.
 */
export type AgentBaseRecord =
    | { readonly type: "user"; readonly message: SessionUserMessage }
    | { readonly type: "block"; readonly block: SessionAssistantBlock }
    | { readonly type: "tool"; readonly message: SessionToolResultMessage }
    | { readonly type: "system"; readonly message: SessionSystemMessage }
    | { readonly type: "compaction"; readonly messages: readonly SessionMessage[] };

/**
 * Storage for one agent: an append-only main context store plus a sorted key-value store held
 * alongside it. A sent message is first written under a `pending.` key ordered by append time;
 * it reaches the main store only when a turn consumes it into the context, and its pending key
 * is deleted at that moment. The agent serializes all calls through one lock, so an
 * implementation never sees two operations in flight at the same time and needs no internal
 * locking.
 */
export interface AgentBasePersistence {
    /**
     * Run work atomically. The implementation opens a transaction and passes work a derived
     * context that its own operations recognize; how the transaction rides on that context is
     * entirely the implementation's business. Work resolving commits every operation; a thrown
     * error rolls them all back.
     */
    transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result>;
    load(ctx: Context): Promise<readonly AgentBaseRecord[]>;
    append(ctx: Context, record: AgentBaseRecord): Promise<void>;
    /**
     * Physically delete every record in the main context store. Called only inside the
     * compaction transaction, immediately before the replacement compaction record is appended,
     * so the deletion and the replacement commit atomically.
     */
    clearRecords(ctx: Context): Promise<void>;
    /** Every stored entry whose key starts with the prefix, sorted by key. */
    readValues(
        ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]>;
    writeValue(ctx: Context, key: string, value: unknown): Promise<void>;
    deleteValue(ctx: Context, key: string): Promise<void>;
}
