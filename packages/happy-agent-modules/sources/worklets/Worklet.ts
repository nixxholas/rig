import { Type, type Static, type TSchema } from "@sinclair/typebox";

/**
 * Worklets are intentionally described in host-neutral terms. A source
 * reference may be a path, an import token, or a database identity; the host
 * decides what it means and where it is stored.
 */
export const MAX_WORKLET_VERSIONS = 100;
export const MAX_WORKLET_LIST_SIZE = 100;
/** A list page may contain one legal maximum-sized worklet, but not an unbounded batch. */
export const MAX_WORKLET_LIST_PAGE_BYTES = 32 * 1024 * 1024;
/** A canonical worklet record must fit comfortably inside one list page. */
export const MAX_WORKLET_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_WORKLET_NAME_LENGTH = 128;
export const MAX_WORKLET_AGENT_ID_LENGTH = 256;
export const MAX_WORKLET_SOURCE_REF_LENGTH = 4_096;
/** Leaves room for a complete `worklet.operation` identity at the 256-char minimum output. */
export const MAX_WORKLET_OPERATION_NAME_LENGTH = 120;
export const MAX_WORKLET_OPERATION_DESCRIPTION_LENGTH = 512;
export const MAX_WORKLET_OPERATIONS = 32;
export const MAX_WORKLET_CHANGE_DESCRIPTION_LENGTH = 512;
export const MAX_WORKLET_STATUS_DETAIL_LENGTH = 2_000;
export const MAX_WORKLET_CURSOR = Number.MAX_SAFE_INTEGER;
export const MAX_WORKLET_LOG_LINES = 1_000;
export const MAX_WORKLET_LOG_LINE_LENGTH = 4_000;
export const MAX_WORKLET_LOG_CHARACTERS = 200_000;
export const MAX_WORKLET_OUTPUT_CHARACTERS = 20_000;
export const MAX_WORKLET_DETAIL_PAGE_SIZE = 4_096;
export const MAX_WORKLET_DETAIL_CHARACTERS = 2_000_000;

/**
 * Recursive arguments and results have limits at every level and a final
 * encoded-byte limit. The module performs the depth/byte checks in addition
 * to this TypeBox shape check.
 */
export const MAX_WORKLET_JSON_DEPTH = 8;
export const MAX_WORKLET_JSON_STRING_LENGTH = 4_096;
export const MAX_WORKLET_JSON_KEY_LENGTH = 128;
export const MAX_WORKLET_JSON_ITEMS = 64;
export const MAX_WORKLET_JSON_PROPERTIES = 64;
export const MAX_WORKLET_INVOCATION_BYTES = 65_536;

export const workletNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_NAME_LENGTH,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

export const workletAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_AGENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workletSourceRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_SOURCE_REF_LENGTH,
    pattern: "^[^\\u0000]+$",
});

export const workletOperationNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_OPERATION_NAME_LENGTH,
    pattern: "^[A-Za-z][A-Za-z0-9._:-]*$",
});

export const workletOperationDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_OPERATION_DESCRIPTION_LENGTH,
});

export const workletChangeDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKLET_CHANGE_DESCRIPTION_LENGTH,
});

export const workletTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

export const workletVersionNumberSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_WORKLET_VERSIONS,
});

export const workletCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKLET_CURSOR,
});

export const workletOperationSchema = Type.Object(
    {
        name: workletOperationNameSchema,
        description: Type.Optional(workletOperationDescriptionSchema),
    },
    { additionalProperties: false },
);

export type WorkletOperation = Static<typeof workletOperationSchema>;

const workletJsonLeafSchema = Type.Union([
    Type.String({ maxLength: MAX_WORKLET_JSON_STRING_LENGTH }),
    Type.Number({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Boolean(),
    Type.Null(),
]);

function workletJsonSchemaAtDepth(depth: number): TSchema {
    if (depth <= 0) return workletJsonLeafSchema;
    const child = workletJsonSchemaAtDepth(depth - 1);
    return Type.Union([
        workletJsonLeafSchema,
        Type.Array(child, { maxItems: MAX_WORKLET_JSON_ITEMS }),
        Type.Record(Type.String({ maxLength: MAX_WORKLET_JSON_KEY_LENGTH }), child, {
            maxProperties: MAX_WORKLET_JSON_PROPERTIES,
        }),
    ]);
}

export const workletJsonValueSchema = workletJsonSchemaAtDepth(MAX_WORKLET_JSON_DEPTH);

export type WorkletJsonValue = Static<typeof workletJsonValueSchema>;

export const workletVersionSchema = Type.Object(
    {
        version: workletVersionNumberSchema,
        sourceRef: workletSourceRefSchema,
        changeDescription: workletChangeDescriptionSchema,
        operations: Type.Array(workletOperationSchema, {
            maxItems: MAX_WORKLET_OPERATIONS,
        }),
        createdAt: workletTimestampSchema,
        /** Stable identity of the host call or durable tool call that added this version. */
        operationId: workletAgentIdSchema,
    },
    { additionalProperties: false },
);

export const workletSchema = Type.Object(
    {
        name: workletNameSchema,
        ownerAgentId: workletAgentIdSchema,
        currentVersion: workletVersionNumberSchema,
        /** Operations declared by the current version, mirrored from its version row. */
        operations: Type.Array(workletOperationSchema, {
            maxItems: MAX_WORKLET_OPERATIONS,
        }),
        versions: Type.Array(workletVersionSchema, {
            minItems: 1,
            maxItems: MAX_WORKLET_VERSIONS,
        }),
        createdAt: workletTimestampSchema,
        updatedAt: workletTimestampSchema,
    },
    { additionalProperties: false },
);

export const workletStatusStateSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("running/awake"),
    Type.Literal("awake"),
    Type.Literal("asleep"),
    Type.Literal("stopped"),
    Type.Literal("failed"),
]);

export const workletStatusSchema = Type.Object(
    {
        name: workletNameSchema,
        state: workletStatusStateSchema,
        detail: Type.Optional(
            Type.String({
                maxLength: MAX_WORKLET_STATUS_DETAIL_LENGTH,
                pattern: "^[^\\u0000]*$",
            }),
        ),
        at: workletTimestampSchema,
    },
    { additionalProperties: false },
);

export const workletDetailSchema = Type.Object(
    {
        ...workletSchema.properties,
        status: workletStatusSchema,
    },
    { additionalProperties: false },
);

export const workletInstallInputSchema = Type.Object(
    {
        name: workletNameSchema,
        sourceRef: workletSourceRefSchema,
        /** Optional for direct host calls; durable tools use their supplied call ID. */
        operationId: Type.Optional(workletAgentIdSchema),
    },
    { additionalProperties: false },
);

export const workletUpdateInputSchema = Type.Object(
    {
        sourceRef: workletSourceRefSchema,
        changeDescription: workletChangeDescriptionSchema,
        /** Optional for direct host calls; durable tools use their supplied call ID. */
        operationId: Type.Optional(workletAgentIdSchema),
    },
    { additionalProperties: false },
);

export const workletRevertInputSchema = Type.Object(
    {
        version: workletVersionNumberSchema,
        /** Optional for direct host calls; durable tools use their supplied call ID. */
        operationId: Type.Optional(workletAgentIdSchema),
    },
    { additionalProperties: false },
);

export const workletToolInstallInputSchema = Type.Omit(workletInstallInputSchema, ["operationId"]);
export const workletToolUpdateInputSchema = Type.Omit(workletUpdateInputSchema, ["operationId"]);
export const workletToolRevertInputSchema = Type.Omit(workletRevertInputSchema, ["operationId"]);

export const workletListQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LIST_SIZE })),
        cursor: Type.Optional(workletCursorSchema),
    },
    { additionalProperties: false },
);

const workletListPageCommonFields = {
    limit: Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LIST_SIZE }),
    previousCursor: Type.Optional(workletCursorSchema),
};

/**
 * `hasMore` is the discriminator for the continuation contract. A page that
 * has more records must return at least one visible record and its next
 * cursor; a terminal page cannot carry a continuation cursor.
 */
export const workletListPageSchema = Type.Union([
    Type.Object(
        {
            ...workletListPageCommonFields,
            worklets: Type.Array(workletSchema, {
                minItems: 1,
                maxItems: MAX_WORKLET_LIST_SIZE,
            }),
            hasMore: Type.Literal(true),
            nextCursor: workletCursorSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletListPageCommonFields,
            worklets: Type.Array(workletSchema, { maxItems: MAX_WORKLET_LIST_SIZE }),
            hasMore: Type.Literal(false),
            nextCursor: Type.Optional(Type.Never()),
        },
        { additionalProperties: false },
    ),
]);

export const workletListSchema = Type.Array(workletSchema, {
    maxItems: MAX_WORKLET_LIST_SIZE,
});

export const workletDetailQuerySchema = Type.Object(
    {
        cursor: Type.Optional(workletCursorSchema),
        limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_DETAIL_PAGE_SIZE }),
        ),
    },
    { additionalProperties: false },
);

export const workletDetailPageSchema = Type.Union([
    Type.Object(
        {
            worklet: workletDetailSchema,
            detail: Type.String({ maxLength: MAX_WORKLET_DETAIL_PAGE_SIZE }),
            cursor: workletCursorSchema,
            limit: Type.Integer({ minimum: 1, maximum: MAX_WORKLET_DETAIL_PAGE_SIZE }),
            total: workletCursorSchema,
            previousCursor: Type.Optional(workletCursorSchema),
            nextCursor: Type.Optional(workletCursorSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object({ worklet: Type.Null() }, { additionalProperties: false }),
]);

export const workletLogQuerySchema = Type.Object(
    {
        cursor: Type.Optional(workletCursorSchema),
        from: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("end")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_LINES })),
        /** Per-line character cap requested by this caller. */
        maxLineCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_LINE_LENGTH }),
        ),
        /** Aggregate character cap requested by this caller. */
        maxCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_CHARACTERS }),
        ),
    },
    { additionalProperties: false },
);

export const workletLogLineSchema = Type.Object(
    {
        position: workletCursorSchema,
        text: Type.String({
            maxLength: MAX_WORKLET_LOG_LINE_LENGTH,
            pattern: "^[^\\u0000]*$",
        }),
    },
    { additionalProperties: false },
);

const workletLogPageCommonFields = {
    name: workletNameSchema,
    totalLines: workletCursorSchema,
};
const workletPositiveCursorSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_WORKLET_CURSOR,
});

/**
 * Cursor presence is represented by the union branches rather than a broad
 * object with two optional continuations. Positive cursors always expose a
 * backward cursor, and a page carrying a forward cursor must contain at
 * least one line. Arithmetic relationships between these positions are
 * checked by the store assertion.
 */
export const workletLogPageSchema = Type.Union([
    Type.Object(
        {
            ...workletLogPageCommonFields,
            cursor: Type.Literal(0),
            lines: Type.Array(workletLogLineSchema, {
                minItems: 1,
                maxItems: MAX_WORKLET_LOG_LINES,
            }),
            nextCursor: workletCursorSchema,
            previousCursor: Type.Optional(Type.Never()),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletLogPageCommonFields,
            cursor: Type.Literal(0),
            lines: Type.Array(workletLogLineSchema, { maxItems: MAX_WORKLET_LOG_LINES }),
            nextCursor: Type.Optional(Type.Never()),
            previousCursor: Type.Optional(Type.Never()),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletLogPageCommonFields,
            cursor: workletPositiveCursorSchema,
            lines: Type.Array(workletLogLineSchema, {
                minItems: 1,
                maxItems: MAX_WORKLET_LOG_LINES,
            }),
            nextCursor: workletCursorSchema,
            previousCursor: workletCursorSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletLogPageCommonFields,
            cursor: workletPositiveCursorSchema,
            lines: Type.Array(workletLogLineSchema, { maxItems: MAX_WORKLET_LOG_LINES }),
            nextCursor: Type.Optional(Type.Never()),
            previousCursor: workletCursorSchema,
        },
        { additionalProperties: false },
    ),
]);

export const workletInvocationInputSchema = Type.Object(
    {
        name: workletNameSchema,
        operation: workletOperationNameSchema,
        arguments: Type.Optional(workletJsonValueSchema),
    },
    { additionalProperties: false },
);

export const workletToolInvocationInputSchema = workletInvocationInputSchema;

export const workletInvocationResultSchema = Type.Object(
    {
        name: workletNameSchema,
        operation: workletOperationNameSchema,
        result: workletJsonValueSchema,
    },
    { additionalProperties: false },
);

export const workletRemovalResultSchema = Type.Object(
    {
        name: workletNameSchema,
        operationId: workletAgentIdSchema,
        removed: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type WorkletName = Static<typeof workletNameSchema>;
export type WorkletAgentId = Static<typeof workletAgentIdSchema>;
export type WorkletSourceRef = Static<typeof workletSourceRefSchema>;
export type WorkletOperationName = Static<typeof workletOperationNameSchema>;
export type WorkletChangeDescription = Static<typeof workletChangeDescriptionSchema>;
export type WorkletTimestamp = Static<typeof workletTimestampSchema>;
export type WorkletVersionNumber = Static<typeof workletVersionNumberSchema>;
export type WorkletCursor = Static<typeof workletCursorSchema>;
export type WorkletVersion = Static<typeof workletVersionSchema>;
export type Worklet = Static<typeof workletSchema>;
export type WorkletStatus = Static<typeof workletStatusSchema>;
export type WorkletDetail = Static<typeof workletDetailSchema>;
export type WorkletInstallInput = Static<typeof workletInstallInputSchema>;
export type WorkletUpdateInput = Static<typeof workletUpdateInputSchema>;
export type WorkletRevertInput = Static<typeof workletRevertInputSchema>;
export type WorkletToolInstallInput = Static<typeof workletToolInstallInputSchema>;
export type WorkletToolUpdateInput = Static<typeof workletToolUpdateInputSchema>;
export type WorkletToolRevertInput = Static<typeof workletToolRevertInputSchema>;
export type WorkletListQuery = Static<typeof workletListQuerySchema>;
export type WorkletListPage = Static<typeof workletListPageSchema>;
export type WorkletDetailQuery = Static<typeof workletDetailQuerySchema>;
export type WorkletDetailPage = Static<typeof workletDetailPageSchema>;
export type WorkletLogQuery = Static<typeof workletLogQuerySchema>;
export type WorkletLogLine = Static<typeof workletLogLineSchema>;
export type WorkletLogPage = Static<typeof workletLogPageSchema>;
export type WorkletInvocationInput = Static<typeof workletInvocationInputSchema>;
export type WorkletInvocationResult = Static<typeof workletInvocationResultSchema>;
export type WorkletRemovalResult = Static<typeof workletRemovalResultSchema>;