/** Durable manual and automatic context-compaction lifecycle. */

import { type Static, Type } from "@sinclair/typebox";

import { cuid2Schema, Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

/** What requested a compaction. */
export const compactionTriggerSchema = Type.Union([
    Type.Literal("manual"),
    Type.Literal("automatic"),
]);
export type CompactionTrigger = Static<typeof compactionTriggerSchema>;

/** A compaction's durable lifecycle state. */
export const compactionStatusSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
]);
export type CompactionStatus = Static<typeof compactionStatusSchema>;

const compactionBaseSchema = Type.Object({
    /** Stable identity of this attempt. */
    id: cuid2Schema,
    /** The agent whose provider context is being replaced. */
    agentId: cuid2Schema,
    /** The active run for an automatic compaction; `null` for manual maintenance. */
    runId: Nullable(cuid2Schema),
    trigger: compactionTriggerSchema,
    /** Exact provider-measured context size before compaction, when available. */
    tokensBefore: Nullable(Type.Integer({ minimum: 0 })),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});

/** A compaction that has started but has not settled. */
export const runningCompactionSchema = Type.Composite([
    compactionBaseSchema,
    Type.Object({
        status: Type.Literal("running"),
        tokensAfter: Type.Null(),
        failureReason: Type.Null(),
        completedAt: Type.Null(),
    }),
]);
export type RunningCompaction = Static<typeof runningCompactionSchema>;

/** A successfully replaced context, optionally measured by a later inference. */
export const completedCompactionSchema = Type.Composite([
    compactionBaseSchema,
    Type.Object({
        status: Type.Literal("completed"),
        tokensAfter: Nullable(Type.Integer({ minimum: 0 })),
        failureReason: Type.Null(),
        completedAt: timestampSchema,
    }),
]);
export type CompletedCompaction = Static<typeof completedCompactionSchema>;

/** A provider failure, cancellation, or interrupted running attempt. */
export const failedCompactionSchema = Type.Composite([
    compactionBaseSchema,
    Type.Object({
        status: Type.Literal("failed"),
        tokensAfter: Type.Null(),
        /** Human-readable terminal detail; consumers never match its text. */
        failureReason: Type.String({ minLength: 1 }),
        completedAt: timestampSchema,
    }),
]);
export type FailedCompaction = Static<typeof failedCompactionSchema>;

/** One durable context-compaction attempt. */
export const compactionSchema = Type.Union([
    runningCompactionSchema,
    completedCompactionSchema,
    failedCompactionSchema,
]);
export type Compaction = Static<typeof compactionSchema>;

/** `GET /v0/agents/:agentId/compactions` query. */
export const compactionListQuerySchema = Type.Object({
    /** Return attempts older than this opaque compaction ID. */
    before: Type.Optional(cuid2Schema),
    /** Default 50; accepted range is 1–100. */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type CompactionListQuery = Static<typeof compactionListQuerySchema>;

/** `GET /v0/agents/:agentId/compactions` */
export const compactionListResponseSchema = Type.Object({
    /** Full compaction resources, newest first. */
    compactions: Type.Array(compactionSchema),
    hasMore: Type.Boolean(),
});
export type CompactionListResponse = Static<typeof compactionListResponseSchema>;
