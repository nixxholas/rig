import { createHash } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKLET_DETAIL_PAGE_SIZE,
    MAX_WORKLET_INVOCATION_BYTES,
    MAX_WORKLET_JSON_DEPTH,
    MAX_WORKLET_LIST_SIZE,
    MAX_WORKLET_LIST_PAGE_BYTES,
    MAX_WORKLET_RECORD_BYTES,
    MAX_WORKLET_LOG_CHARACTERS,
    MAX_WORKLET_LOG_LINE_LENGTH,
    MAX_WORKLET_LOG_LINES,
    MAX_WORKLET_OPERATION_NAME_LENGTH,
    MAX_WORKLET_OPERATIONS,
    MAX_WORKLET_VERSIONS,
    workletAgentIdSchema,
    workletChangeDescriptionSchema,
    workletCursorSchema,
    workletDetailQuerySchema,
    workletDetailPageSchema,
    workletDetailSchema,
    workletInvocationResultSchema,
    workletJsonValueSchema,
    workletListPageSchema,
    workletListQuerySchema,
    workletLogPageSchema,
    workletLogQuerySchema,
    workletNameSchema,
    workletOperationSchema,
    workletSchema,
    workletSourceRefSchema,
    workletStatusSchema,
    workletTimestampSchema,
    workletVersionNumberSchema,
    workletVersionSchema,
    type Worklet,
    type WorkletDetailPage,
    type WorkletInvocationResult,
    type WorkletListPage,
    type WorkletLogPage,
    type WorkletStatus,
} from "./Worklet.js";
import { workletEventSchema, type WorkletEvent } from "./WorkletEvent.js";

const opaqueContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);
const unknownPromiseSchema = Type.Promise(Type.Unknown());
const transactionWorkSchema = Type.Function([opaqueContextSchema], unknownPromiseSchema);
const commitCallbackSchema = Type.Function(
    [opaqueContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const syncVoidSchema = Type.Void();

export const workletCatalogOperationSchema = Type.Union([
    Type.Literal("install"),
    Type.Literal("update"),
    Type.Literal("revert"),
    Type.Literal("remove"),
]);

export const workletFingerprintSchema = Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: "^[a-f0-9]{64}$",
});

/**
 * Compact immutable evidence for a worklet record. The fingerprint binds the
 * complete validated record without copying its version history into every
 * proof row.
 */
export const workletStateIdentitySchema = Type.Object(
    {
        name: workletNameSchema,
        ownerAgentId: workletAgentIdSchema,
        currentVersion: workletVersionNumberSchema,
        versionCount: Type.Integer({
            minimum: 1,
            maximum: MAX_WORKLET_VERSIONS,
        }),
        createdAt: workletTimestampSchema,
        updatedAt: workletTimestampSchema,
        fingerprint: workletFingerprintSchema,
    },
    { additionalProperties: false },
);
export type WorkletStateIdentity = Static<typeof workletStateIdentitySchema>;

export const workletStageInputSchema = Type.Object(
    {
        name: workletNameSchema,
        ownerAgentId: workletAgentIdSchema,
        version: workletVersionNumberSchema,
        sourceRef: workletSourceRefSchema,
        operationId: workletAgentIdSchema,
        /**
         * Only a revert may reuse an existing version directory. Installs and
         * updates always copy into a fresh staging directory so an old path can
         * never silently become the new source.
         */
        reuseExisting: Type.Boolean(),
    },
    { additionalProperties: false },
);

export const workletStageSchema = Type.Object(
    {
        stageId: workletAgentIdSchema,
        name: workletNameSchema,
        ownerAgentId: workletAgentIdSchema,
        version: workletVersionNumberSchema,
        sourceRef: workletSourceRefSchema,
        operationId: workletAgentIdSchema,
        operations: Type.Array(workletOperationSchema, {
            maxItems: MAX_WORKLET_OPERATIONS,
        }),
    },
    { additionalProperties: false },
);

export const workletCatalogInstallInputSchema = Type.Object(
    {
        name: workletNameSchema,
        ownerAgentId: workletAgentIdSchema,
        initialVersion: Type.Object(
            {
                version: Type.Literal(1),
                sourceRef: workletSourceRefSchema,
                changeDescription: Type.Literal("Initial install"),
                operations: Type.Array(workletOperationSchema, {
                    maxItems: MAX_WORKLET_OPERATIONS,
                }),
                createdAt: workletTimestampSchema,
                operationId: workletAgentIdSchema,
            },
            { additionalProperties: false },
        ),
        operationId: workletAgentIdSchema,
    },
    { additionalProperties: false },
);

export const workletCatalogUpdateInputSchema = Type.Object(
    {
        version: workletVersionNumberSchema,
        sourceRef: workletSourceRefSchema,
        changeDescription: workletChangeDescriptionSchema,
        operations: Type.Array(workletOperationSchema, {
            maxItems: MAX_WORKLET_OPERATIONS,
        }),
        createdAt: workletTimestampSchema,
        operationId: workletAgentIdSchema,
    },
    { additionalProperties: false },
);

export const workletCatalogRevertInputSchema = Type.Object(
    {
        version: workletVersionNumberSchema,
        operationId: workletAgentIdSchema,
    },
    { additionalProperties: false },
);

const workletMutationFields = {
    name: workletNameSchema,
    operationId: workletAgentIdSchema,
    targetVersion: Type.Integer({ minimum: 0, maximum: MAX_WORKLET_VERSIONS }),
    currentVersion: Type.Integer({ minimum: 0, maximum: MAX_WORKLET_VERSIONS }),
    changed: Type.Boolean(),
};

export const workletCatalogInstallResultSchema = Type.Object(
    {
        ...workletMutationFields,
        operation: Type.Literal("install"),
        worklet: workletSchema,
    },
    { additionalProperties: false },
);

export const workletCatalogUpdateResultSchema = Type.Object(
    {
        ...workletMutationFields,
        operation: Type.Literal("update"),
        worklet: workletSchema,
    },
    { additionalProperties: false },
);

export const workletCatalogRevertResultSchema = Type.Object(
    {
        ...workletMutationFields,
        operation: Type.Literal("revert"),
        worklet: workletSchema,
    },
    { additionalProperties: false },
);

export const workletCatalogRemoveResultSchema = Type.Object(
    {
        ...workletMutationFields,
        operation: Type.Literal("remove"),
        removed: Type.Boolean(),
    },
    { additionalProperties: false },
);

export const workletCatalogMutationResultSchema = Type.Union([
    workletCatalogInstallResultSchema,
    workletCatalogUpdateResultSchema,
    workletCatalogRevertResultSchema,
    workletCatalogRemoveResultSchema,
]);

/** Proofs retain only the result identity; receipts retain bounded replay material. */
export const workletCatalogMutationProofResultSchema = Type.Union([
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("install"),
            worklet: workletStateIdentitySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("update"),
            worklet: workletStateIdentitySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("revert"),
            worklet: workletStateIdentitySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("remove"),
            removed: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
]);

/**
 * A receipt stores only the version introduced by an install/update and a
 * pointer to the preceding version receipt. Replay reconstructs the settled
 * worklet by following that bounded chain, so a receipt never duplicates the
 * entire version history.
 */
export const workletCatalogMutationReceiptResultSchema = Type.Union([
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("install"),
            worklet: workletStateIdentitySchema,
            version: workletVersionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("update"),
            worklet: workletStateIdentitySchema,
            version: workletVersionSchema,
            historyOperationId: workletAgentIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("revert"),
            worklet: workletStateIdentitySchema,
            historyOperationId: workletAgentIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workletMutationFields,
            operation: Type.Literal("remove"),
            removed: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
]);

/**
 * Receipts are replay material. They are always paired with the immutable
 * proof below and checked against the authoritative catalog before replay.
 */
export const workletCatalogMutationReceiptSchema = Type.Object(
    {
        operation: workletCatalogOperationSchema,
        agentId: workletAgentIdSchema,
        name: workletNameSchema,
        operationId: workletAgentIdSchema,
        fingerprint: workletFingerprintSchema,
        beforeExists: Type.Boolean(),
        beforeCurrentVersion: Type.Integer({
            minimum: 0,
            maximum: MAX_WORKLET_VERSIONS,
        }),
        result: workletCatalogMutationReceiptResultSchema,
    },
    { additionalProperties: false },
);

/** Independent durable proof of the exact before/after transition. */
export const workletCatalogMutationProofSchema = Type.Object(
    {
        operation: workletCatalogOperationSchema,
        agentId: workletAgentIdSchema,
        name: workletNameSchema,
        operationId: workletAgentIdSchema,
        fingerprint: workletFingerprintSchema,
        before: Type.Union([workletStateIdentitySchema, Type.Null()]),
        after: Type.Union([workletStateIdentitySchema, Type.Null()]),
        changed: Type.Boolean(),
        result: workletCatalogMutationProofResultSchema,
    },
    { additionalProperties: false },
);

export const workletTransactionChangeSchema = Type.Object(
    {
        result: workletCatalogMutationResultSchema,
        event: Type.Optional(workletEventSchema),
    },
    { additionalProperties: false },
);

/**
 * A host catalog owns only durable metadata: worklet rows, contiguous version
 * history, the current-version pointer, receipts, and immutable mutation
 * proofs. The feature itself now owns the filesystem — verifying a source
 * folder and copying it into the versioned layout — so the catalog no longer
 * stages, commits, or rolls back source imports.
 */
export const workletCatalogSchema = Type.Object(
    {
        transaction: Type.Function(
            [opaqueContextSchema, transactionWorkSchema],
            unknownPromiseSchema,
        ),
        afterCommit: Type.Function(
            [opaqueContextSchema, commitCallbackSchema],
            syncVoidSchema,
        ),
        onRollback: Type.Function(
            [opaqueContextSchema, commitCallbackSchema],
            syncVoidSchema,
        ),
        list: Type.Function(
            [opaqueContextSchema, workletListQuerySchema],
            Type.Promise(workletListPageSchema),
        ),
        get: Type.Function(
            [opaqueContextSchema, workletNameSchema],
            Type.Promise(Type.Union([workletSchema, Type.Undefined()])),
        ),
        install: Type.Function(
            [opaqueContextSchema, workletCatalogInstallInputSchema],
            Type.Promise(workletCatalogInstallResultSchema),
        ),
        update: Type.Function(
            [opaqueContextSchema, workletNameSchema, workletCatalogUpdateInputSchema],
            Type.Promise(workletCatalogUpdateResultSchema),
        ),
        revert: Type.Function(
            [opaqueContextSchema, workletNameSchema, workletCatalogRevertInputSchema],
            Type.Promise(workletCatalogRevertResultSchema),
        ),
        remove: Type.Function(
            [opaqueContextSchema, workletNameSchema, workletAgentIdSchema],
            Type.Promise(workletCatalogRemoveResultSchema),
        ),
        readReceipt: Type.Function(
            [opaqueContextSchema, workletAgentIdSchema],
            Type.Promise(
                Type.Union([workletCatalogMutationReceiptSchema, Type.Undefined()]),
            ),
        ),
        writeReceipt: Type.Function(
            [opaqueContextSchema, workletCatalogMutationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        readMutationProof: Type.Function(
            [opaqueContextSchema, workletAgentIdSchema],
            Type.Promise(
                Type.Union([workletCatalogMutationProofSchema, Type.Undefined()]),
            ),
        ),
        writeMutationProof: Type.Function(
            [opaqueContextSchema, workletCatalogMutationProofSchema],
            Type.Promise(Type.Void()),
        ),
    },
    { additionalProperties: false },
);

export const workletRuntimeLogQuerySchema = Type.Object(
    {
        name: workletNameSchema,
        cursor: Type.Optional(workletCursorSchema),
        from: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("end")])),
        limit: Type.Integer({ minimum: 1, maximum: MAX_WORKLET_LOG_LINES }),
        maxLineCharacters: Type.Integer({
            minimum: 1,
            maximum: MAX_WORKLET_LOG_LINE_LENGTH,
        }),
        maxCharacters: Type.Integer({
            minimum: 1,
            maximum: MAX_WORKLET_LOG_CHARACTERS,
        }),
    },
    { additionalProperties: false },
);

export const workletRuntimeInvocationRequestSchema = Type.Object(
    {
        name: workletNameSchema,
        operation: Type.String({
            minLength: 1,
            maxLength: MAX_WORKLET_OPERATION_NAME_LENGTH,
        }),
        arguments: workletJsonValueSchema,
        /** Generic runtime cap; the feature validates argument/result depths separately. */
        maxDepth: Type.Integer({ minimum: 1, maximum: MAX_WORKLET_JSON_DEPTH }),
        maxBytes: Type.Integer({ minimum: 1, maximum: MAX_WORKLET_INVOCATION_BYTES }),
    },
    { additionalProperties: false },
);

export const workletRuntimeSchema = Type.Object(
    {
        status: Type.Function(
            [opaqueContextSchema, workletNameSchema],
            Type.Promise(workletStatusSchema),
        ),
        readLogs: Type.Function(
            [opaqueContextSchema, workletRuntimeLogQuerySchema],
            Type.Promise(workletLogPageSchema),
        ),
        invokeOperation: Type.Function(
            [opaqueContextSchema, workletRuntimeInvocationRequestSchema],
            Type.Promise(workletInvocationResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type WorkletCatalog = Static<typeof workletCatalogSchema>;
export type WorkletCatalogInstallInput = Static<
    typeof workletCatalogInstallInputSchema
>;
export type WorkletCatalogUpdateInput = Static<
    typeof workletCatalogUpdateInputSchema
>;
export type WorkletCatalogRevertInput = Static<
    typeof workletCatalogRevertInputSchema
>;
export type WorkletStageInput = Static<typeof workletStageInputSchema>;
export type WorkletStage = Static<typeof workletStageSchema>;
export type WorkletCatalogMutationResult = Static<
    typeof workletCatalogMutationResultSchema
>;
export type WorkletCatalogMutationProofResult = Static<
    typeof workletCatalogMutationProofResultSchema
>;
export type WorkletCatalogMutationReceiptResult = Static<
    typeof workletCatalogMutationReceiptResultSchema
>;
export type WorkletCatalogMutationReceipt = Static<
    typeof workletCatalogMutationReceiptSchema
>;
export type WorkletCatalogMutationProof = Static<
    typeof workletCatalogMutationProofSchema
>;
export type WorkletCatalogOperation = Static<
    typeof workletCatalogOperationSchema
>;
export type WorkletFingerprint = Static<typeof workletFingerprintSchema>;
export type WorkletCatalogInstallResult = Extract<
    WorkletCatalogMutationResult,
    { operation: "install" }
>;
export type WorkletCatalogUpdateResult = Extract<
    WorkletCatalogMutationResult,
    { operation: "update" }
>;
export type WorkletCatalogRevertResult = Extract<
    WorkletCatalogMutationResult,
    { operation: "revert" }
>;
export type WorkletCatalogRemoveResult = Extract<
    WorkletCatalogMutationResult,
    { operation: "remove" }
>;
export type WorkletTransactionChange = Static<
    typeof workletTransactionChangeSchema
>;
export type WorkletRuntimeLogQuery = Static<
    typeof workletRuntimeLogQuerySchema
>;
export type WorkletRuntimeInvocationRequest = Static<
    typeof workletRuntimeInvocationRequestSchema
>;
export type WorkletRuntime = Static<typeof workletRuntimeSchema>;

export function assertWorkletOperationList(value: unknown): asserts value is Worklet["operations"] {
    if (
        !Value.Check(
            Type.Array(workletOperationSchema, { maxItems: MAX_WORKLET_OPERATIONS }),
            value,
        )
    ) {
        throw new Error("Worklet operations are invalid.");
    }
    const names = new Set<string>();
    for (const operation of value) {
        if (names.has(operation.name)) {
            throw new Error("Worklet operation names must be unique.");
        }
        names.add(operation.name);
    }
}

export function assertWorklet(value: unknown): asserts value is Worklet {
    if (!Value.Check(workletSchema, value)) {
        throw new Error("Worklet catalog returned an invalid worklet.");
    }
    assertWorkletOperationList(value.operations);
    if (value.versions[0]?.version !== 1) {
        throw new Error("Worklet versions must start at version 1.");
    }
    if (value.versions[0]?.createdAt !== value.createdAt) {
        throw new Error("Worklet createdAt must match its initial version.");
    }
    const operationIds = new Set<string>();
    let previousCreatedAt = value.createdAt;
    for (const [index, version] of value.versions.entries()) {
        if (version.version !== index + 1) {
            throw new Error("Worklet versions must be contiguous and ordered.");
        }
        assertWorkletOperationList(version.operations);
        if (operationIds.has(version.operationId)) {
            throw new Error("Worklet version operation IDs must be unique.");
        }
        operationIds.add(version.operationId);
        if (version.createdAt < previousCreatedAt) {
            throw new Error("Worklet version timestamps must be ordered.");
        }
        if (version.createdAt > value.updatedAt) {
            throw new Error("Worklet version timestamps exceed updatedAt.");
        }
        previousCreatedAt = version.createdAt;
    }
    const current = value.versions.find(
        (version) => version.version === value.currentVersion,
    );
    if (current === undefined) {
        throw new Error("Worklet currentVersion is missing from its version history.");
    }
    if (!sameValue(value.operations, current.operations)) {
        throw new Error("Worklet operations do not match the current version.");
    }
    if (value.updatedAt < value.createdAt || value.updatedAt < current.createdAt) {
        throw new Error("Worklet timestamps are not ordered.");
    }
    const encoded = canonicalEncoded(value);
    if (new TextEncoder().encode(encoded).byteLength > MAX_WORKLET_RECORD_BYTES) {
        throw new Error("Worklet record exceeds its aggregate byte bound.");
    }
}

export function workletStateIdentity(worklet: Worklet): WorkletStateIdentity {
    assertWorklet(worklet);
    const encoded = canonicalEncoded(worklet);
    return {
        name: worklet.name,
        ownerAgentId: worklet.ownerAgentId,
        currentVersion: worklet.currentVersion,
        versionCount: worklet.versions.length,
        createdAt: worklet.createdAt,
        updatedAt: worklet.updatedAt,
        fingerprint: createHash("sha256").update(encoded).digest("hex"),
    };
}

export function assertWorkletStateIdentity(
    value: unknown,
): asserts value is WorkletStateIdentity {
    if (!Value.Check(workletStateIdentitySchema, value)) {
        throw new Error("Worklet state identity is invalid.");
    }
}

export function assertWorkletStatus(value: unknown): asserts value is WorkletStatus {
    if (!Value.Check(workletStatusSchema, value)) {
        throw new Error("Worklet runtime returned an invalid status.");
    }
}

export function assertWorkletListPage(value: unknown): asserts value is WorkletListPage {
    assertWorkletListPageShape(value);
    const page = value as WorkletListPage;
    const encoded = JSON.stringify(page.worklets);
    if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength > MAX_WORKLET_LIST_PAGE_BYTES
    ) {
        throw new Error("Worklet catalog list page exceeds its aggregate byte bound.");
    }
}

export function assertWorkletListPageShape(
    value: unknown,
): asserts value is WorkletListPage {
    if (!Value.Check(workletListPageSchema, value)) {
        throw new Error("Worklet catalog returned an invalid list page.");
    }
    const page = value as WorkletListPage;
    if (page.worklets.length > page.limit) {
        throw new Error("Worklet catalog returned too many worklets.");
    }
    const names = new Set<string>();
    for (const worklet of page.worklets) {
        assertWorklet(worklet);
        if (names.has(worklet.name)) {
            throw new Error("Worklet catalog returned duplicate names.");
        }
        names.add(worklet.name);
    }
    if (page.hasMore && page.worklets.length === 0) {
        throw new Error("A non-terminal worklet page must make item progress.");
    }
}

export function assertWorkletDetailPage(
    value: unknown,
): asserts value is WorkletDetailPage {
    if (!Value.Check(workletDetailPageSchema, value)) {
        throw new Error("Worklet detail page is invalid.");
    }
    if (value.worklet !== null) {
        if (!Value.Check(workletDetailSchema, value.worklet)) {
            throw new Error("Worklet detail page returned an invalid detail record.");
        }
        const { status: _status, ...catalogWorklet } = value.worklet;
        assertWorklet(catalogWorklet);
        assertWorkletStatus(value.worklet.status);
        if (value.worklet.status.name !== value.worklet.name) {
            throw new Error("Worklet detail status names do not match.");
        }
        if (
            value.detail.length > 0 &&
            value.cursor + value.detail.length > value.total
        ) {
            throw new Error("Worklet detail page exceeds its total.");
        }
        if (value.detail.length > value.limit) {
            throw new Error("Worklet detail page exceeds its requested limit.");
        }
        if (
            value.nextCursor !== undefined &&
            (value.nextCursor <= value.cursor ||
                value.nextCursor !== value.cursor + value.detail.length)
        ) {
            throw new Error("Worklet detail page cursor did not advance exactly.");
        }
        if (
            value.previousCursor !== undefined &&
            (value.previousCursor >= value.cursor ||
                value.previousCursor > value.total)
        ) {
            throw new Error("Worklet detail page previous cursor did not move backward.");
        }
        if (
            value.total > 0 &&
            value.cursor > 0 &&
            value.detail.length === 0 &&
            value.previousCursor === undefined
        ) {
            throw new Error(
                "Worklet detail page must expose a previous cursor for an empty page beyond the start.",
            );
        }
        if (value.nextCursor === undefined && value.cursor + value.detail.length < value.total) {
            throw new Error("Worklet detail page omitted a continuation cursor.");
        }
    }
}

export function assertWorkletLogPage(value: unknown): asserts value is WorkletLogPage {
    if (!Value.Check(workletLogPageSchema, value)) {
        throw new Error("Worklet runtime returned an invalid log page.");
    }
    const page = value as WorkletLogPage;
    if (page.cursor > page.totalLines) {
        throw new Error("Worklet log page cursor exceeds its total.");
    }
    if (page.lines[0] !== undefined && page.lines[0].position !== page.cursor) {
        throw new Error("Worklet log page must start at its requested cursor.");
    }
    if (
        page.lines.some(
            (line: WorkletLogPage["lines"][number], index: number) =>
                line.position >= page.totalLines ||
                (index > 0 &&
                    line.position !== page.lines[index - 1]!.position + 1),
        )
    ) {
        throw new Error("Worklet log positions must be ordered.");
    }
    const hasMore = page.cursor < page.totalLines - page.lines.length;
    if (hasMore) {
        if (
            page.nextCursor === undefined ||
            page.nextCursor <= page.cursor ||
            page.nextCursor !== page.cursor + page.lines.length
        ) {
            throw new Error("Worklet log page omitted an exact continuation cursor.");
        }
    } else if (page.nextCursor !== undefined) {
        throw new Error("Worklet log page returned a continuation after the end.");
    }
    if (page.cursor > 0 && page.previousCursor === undefined) {
        throw new Error("Worklet log page must expose a previous cursor beyond the start.");
    }
    if (
        page.previousCursor !== undefined &&
        page.previousCursor >= page.cursor
    ) {
        throw new Error("Worklet log page previous cursor did not move backward.");
    }
}

export function assertWorkletInvocationResult(
    value: unknown,
): asserts value is WorkletInvocationResult {
    if (!Value.Check(workletInvocationResultSchema, value)) {
        throw new Error("Worklet runtime returned an invalid operation result.");
    }
}

export function assertWorkletMutation(
    value: unknown,
): asserts value is WorkletCatalogMutationResult {
    if (!Value.Check(workletCatalogMutationResultSchema, value)) {
        throw new Error("Worklet catalog returned an invalid mutation result.");
    }
    if ("worklet" in value) {
        assertWorklet(value.worklet);
        if (
            value.worklet.name !== value.name ||
            value.worklet.currentVersion !== value.currentVersion ||
            !value.worklet.versions.some(
                (version) => version.version === value.targetVersion,
            )
        ) {
            throw new Error("Worklet mutation result identity is inconsistent.");
        }
    } else if (
        value.targetVersion !== 0 ||
        value.currentVersion !== 0 ||
        value.removed !== value.changed
    ) {
        throw new Error("Worklet remove result identity is inconsistent.");
    }
}

export function assertWorkletReceipt(
    value: unknown,
): asserts value is WorkletCatalogMutationReceipt {
    if (!Value.Check(workletCatalogMutationReceiptSchema, value)) {
        throw new Error("Worklet catalog returned an invalid replay receipt.");
    }
    if (
        value.result.operation === "remove" &&
        (value.result.changed !== value.result.removed ||
            value.result.changed !== value.beforeExists)
    ) {
        throw new Error("Worklet remove receipt changed/removed state is inconsistent.");
    }
    if (
        value.result.operation !== value.operation ||
        value.result.name !== value.name ||
        value.result.operationId !== value.operationId
    ) {
        throw new Error("Worklet replay receipt identity is inconsistent.");
    }
    if ("worklet" in value.result) {
        assertWorkletStateIdentity(value.result.worklet);
        if (
            value.result.worklet.name !== value.name ||
            value.result.worklet.currentVersion !== value.result.currentVersion
        ) {
            throw new Error("Worklet replay receipt settled identity is inconsistent.");
        }
    }
    if (value.beforeExists !== (value.beforeCurrentVersion > 0)) {
        throw new Error("Worklet replay receipt has an invalid before-state marker.");
    }
    if (value.result.operation === "install") {
        if (
            value.result.targetVersion !== 1 ||
            value.result.currentVersion !== 1 ||
            value.result.changed !== true ||
            value.result.version.version !== 1 ||
            value.result.version.operationId !== value.operationId ||
            value.result.worklet.currentVersion !== 1 ||
            value.result.worklet.versionCount !== 1
        ) {
            throw new Error("Worklet install receipt result is inconsistent.");
        }
    } else if (value.result.operation === "update") {
        if (
            value.result.targetVersion !== value.result.version.version ||
            value.result.currentVersion !== value.result.version.version ||
            value.result.changed !== true ||
            value.result.version.operationId !== value.operationId ||
            value.result.historyOperationId === value.operationId
        ) {
            throw new Error("Worklet update receipt result is inconsistent.");
        }
    } else if (value.result.operation === "revert") {
        if (
            value.result.targetVersion < 1 ||
            value.result.currentVersion !== value.result.targetVersion ||
            value.result.historyOperationId === value.operationId
        ) {
            throw new Error("Worklet revert receipt result is inconsistent.");
        }
    }
}

export function assertWorkletProof(
    value: unknown,
): asserts value is WorkletCatalogMutationProof {
    if (!Value.Check(workletCatalogMutationProofSchema, value)) {
        throw new Error("Worklet catalog returned an invalid mutation proof.");
    }
    if (value.before !== null) assertWorkletStateIdentity(value.before);
    if (value.after !== null) assertWorkletStateIdentity(value.after);
    if (value.before !== null && value.before.name !== value.name) {
        throw new Error("Worklet mutation proof before-state name does not match its target.");
    }
    if (value.after !== null && value.after.name !== value.name) {
        throw new Error("Worklet mutation proof after-state name does not match its target.");
    }
    if (!Value.Check(workletCatalogMutationProofResultSchema, value.result)) {
        throw new Error("Worklet mutation proof result is invalid.");
    }
    if ("worklet" in value.result) {
        assertWorkletStateIdentity(value.result.worklet);
    }
    if (
        value.result.operation !== value.operation ||
        value.result.name !== value.name ||
        value.result.operationId !== value.operationId
    ) {
        throw new Error("Worklet mutation proof identity is inconsistent.");
    }
    const derivedChanged =
        value.before === null
            ? value.after !== null
            : value.after === null || !sameValue(value.before, value.after);
    if (value.changed !== derivedChanged) {
        throw new Error("Worklet mutation proof changed flag is inconsistent with its states.");
    }
    if (value.operation === "remove") {
        if (
            value.after !== null ||
            "worklet" in value.result ||
            value.result.removed !== value.changed
        ) {
            throw new Error("Worklet remove proof has an invalid after-state.");
        }
    } else if (
        value.after === null ||
        !("worklet" in value.result) ||
        !sameValue(value.after, value.result.worklet)
    ) {
        throw new Error("Worklet mutation proof after-state is inconsistent.");
    }
    if (value.changed !== value.result.changed) {
        throw new Error("Worklet mutation proof changed flag is inconsistent.");
    }
}

export function assertWorkletStage(value: unknown): asserts value is WorkletStage {
    if (!Value.Check(workletStageSchema, value)) {
        throw new Error("Worklet catalog returned an invalid staging result.");
    }
    assertWorkletOperationList(value.operations);
}

export function assertWorkletTransactionChange(
    value: unknown,
): asserts value is WorkletTransactionChange {
    if (!Value.Check(workletTransactionChangeSchema, value)) {
        throw new Error("Worklet catalog transaction returned an invalid change.");
    }
    assertWorkletMutation(value.result);
}

export function assertWorkletRuntimeLogQuery(
    value: unknown,
): asserts value is WorkletRuntimeLogQuery {
    if (!Value.Check(workletRuntimeLogQuerySchema, value)) {
        throw new Error("Worklet runtime log query is invalid.");
    }
}

export function assertWorkletRuntimeInvocationRequest(
    value: unknown,
): asserts value is WorkletRuntimeInvocationRequest {
    if (!Value.Check(workletRuntimeInvocationRequestSchema, value)) {
        throw new Error("Worklet runtime invocation request is invalid.");
    }
}

function sameValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((item, index) => sameValue(item, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(rightRecord, key) &&
                sameValue(leftRecord[key], rightRecord[key]),
        )
    );
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonicalize(item)]),
        );
    }
    return value;
}

function canonicalEncoded(value: unknown): string {
    const encoded = JSON.stringify(canonicalize(value));
    if (encoded === undefined) {
        throw new Error("Worklet state could not be encoded.");
    }
    return encoded;
}