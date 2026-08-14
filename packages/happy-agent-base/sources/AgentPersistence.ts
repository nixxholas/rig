import type {
    SessionAssistantBlock,
    SessionMessage,
    SessionSystemMessage,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentMessageMetadata } from "./AgentMetadata.js";

/**
 * One record of the main context store. Only content that is part of the model context lives
 * here: user messages enter when a turn consumes them, assistant output is appended one finished
 * block at a time, and tool results follow the blocks that called them, so records always arrive
 * in context order and consecutive block records reassemble into one assistant message. A
 * compaction record carries the complete replacement context — the messages that stay — and is
 * written in the same transaction that physically deletes the superseded records, so it opens
 * the store; the records after it append as usual.
 */
export type AgentRecord =
    | {
          readonly type: "user";
          readonly id: string;
          readonly message: SessionUserMessage;
          readonly metadata?: AgentMessageMetadata;
      }
    | { readonly type: "block"; readonly block: SessionAssistantBlock }
    | { readonly type: "tool"; readonly message: SessionToolResultMessage }
    | { readonly type: "system"; readonly message: SessionSystemMessage }
    | {
          readonly type: "compaction";
          readonly messages: readonly SessionMessage[];
      };

/**
 * Storage for one agent: an append-only main context store plus a sorted key-value store held
 * alongside it. A sent message is first written under a `pending.` key ordered by append time;
 * it reaches the main store only when a turn consumes it into the context, and its pending key
 * is deleted at that moment. A `message.` uniqueness key makes retrying a cuid2 message ID an
 * ignored database conflict; history replacement removes keys for the records it deletes.
 * Exactly one owner connects to a store, and the agent serializes its own record and bookkeeping
 * writes through one lock, so history order always matches storage order. Key-value operations —
 * a feature's or a tool's — run as they come, so each one has to be atomic on its own, but no
 * implementation ever has to defend against a second owner.
 */
export interface AgentPersistence {
    /**
     * Run work atomically. The implementation opens a transaction and passes work a derived
     * context that its own operations recognize; how the transaction rides on that context is
     * entirely the implementation's business. Work resolving commits every operation; a thrown
     * error rolls them all back.
     */
    transaction<Result>(ctx: Context, work: (ctx: Context) => Promise<Result>): Promise<Result>;
    /** Every record in the main context store, in append order. */
    load(ctx: Context): Promise<readonly AgentRecord[]>;
    /** Add one more record to the end of the main context store. */
    append(ctx: Context, record: AgentRecord): Promise<void>;
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
    /** Store the value under `key`, replacing whatever was there before. */
    writeValue(ctx: Context, key: string, value: unknown): Promise<void>;
    /**
     * Store the value only when `key` is absent. Returns false for the database uniqueness
     * conflict without changing the existing value.
     */
    writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean>;
    /** Remove the entry stored under `key`, if any. */
    deleteValue(ctx: Context, key: string): Promise<void>;
}
