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
    | {
          readonly type: "compaction";
          readonly messages: readonly SessionMessage[];
          /**
           * Whether the replacement ends on something that is still owed an answer. A summary is
           * not a question however it happens to end, so a restart does not respond to one — but
           * a replacement also keeps whatever joined the conversation after its snapshot, and a
           * message kept that way is owed exactly what it was owed before the rewrite. The
           * rewrite is the only place that still knows which of the two it wrote.
           */
          readonly owed?: boolean;
      };

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
    transaction<Result>(ctx: Context, work: (ctx: Context) => Promise<Result>): Promise<Result>;
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
    /**
     * Write the value only if the key is absent, and report whether this call is the one that
     * wrote it. The check and the write are a single atomic step, so of two writers racing for
     * the same key exactly one is told it won — which is what makes a durable identity, such as
     * an agent's creation record, safe to claim from more than one owner at a time.
     */
    writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean>;
    /**
     * Write the value only if the stored one is still what the caller decided from, and report
     * whether this call is the one that wrote it. The comparison and the write are a single
     * atomic step, so a read-decide-write sequence can be made safe against another owner who
     * decided from the same value: the loser is told it lost and decides again, instead of
     * overwriting a decision it never saw. Absence is a value like any other, and matches an
     * expectation of `undefined`.
     */
    writeValueIfUnchanged(
        ctx: Context,
        key: string,
        expected: unknown,
        value: unknown,
    ): Promise<boolean>;
    deleteValue(ctx: Context, key: string): Promise<void>;
    /**
     * Delete the key and report whether this call is the one that removed it. The check and the
     * deletion are a single atomic step and take effect at once — a transaction that later rolls
     * back restores the entry. This is how a durable queue entry is claimed: of several owners
     * over one store racing to consume the same message, exactly one is told it won.
     */
    deleteValueIfPresent(ctx: Context, key: string): Promise<boolean>;
}
