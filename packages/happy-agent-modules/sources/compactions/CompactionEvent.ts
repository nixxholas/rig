import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { compactionSchema, compactionTimestampSchema } from "./Compaction.js";

export const compactionEventSchema = Type.Union([
    Type.Object(
        {
            at: compactionTimestampSchema,
            compaction: compactionSchema,
            type: Type.Literal("compaction_created"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            at: compactionTimestampSchema,
            compaction: compactionSchema,
            previous: compactionSchema,
            type: Type.Literal("compaction_updated"),
        },
        { additionalProperties: false },
    ),
]);

export type CompactionEvent = Static<typeof compactionEventSchema>;

export const compactionEventListenerSchema = Type.Function(
    [Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true })), compactionEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export type CompactionEventListener = (
    ctx: Context,
    event: CompactionEvent,
) => void | Promise<void>;
