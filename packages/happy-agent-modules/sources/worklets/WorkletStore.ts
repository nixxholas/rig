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
    type Worklet,
    type WorkletDetailPage,
    type WorkletInvocationResult,
    type WorkletListPage,
    type WorkletLogPage,
    type WorkletStatus,
} from "./Worklet.js";

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
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

/** Module-owned worklet database surface for durable metadata. */
export const workletCatalogSchema = Type.Object(
    {
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
        /** Generic runtime cap; the module validates argument/result depths separately. */
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
export type WorkletCatalogInstallInput = Static<typeof workletCatalogInstallInputSchema>;
export type WorkletCatalogUpdateInput = Static<typeof workletCatalogUpdateInputSchema>;
export type WorkletCatalogRevertInput = Static<typeof workletCatalogRevertInputSchema>;
export type WorkletStageInput = Static<typeof workletStageInputSchema>;
export type WorkletStage = Static<typeof workletStageSchema>;
export type WorkletCatalogMutationResult = Static<typeof workletCatalogMutationResultSchema>;
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
export type WorkletRuntimeLogQuery = Static<typeof workletRuntimeLogQuerySchema>;
export type WorkletRuntimeInvocationRequest = Static<typeof workletRuntimeInvocationRequestSchema>;
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
    const current = value.versions.find((version) => version.version === value.currentVersion);
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

export function assertWorkletListPageShape(value: unknown): asserts value is WorkletListPage {
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

export function assertWorkletDetailPage(value: unknown): asserts value is WorkletDetailPage {
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
        if (value.detail.length > 0 && value.cursor + value.detail.length > value.total) {
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
            (value.previousCursor >= value.cursor || value.previousCursor > value.total)
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
                (index > 0 && line.position !== page.lines[index - 1]!.position + 1),
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
    if (page.previousCursor !== undefined && page.previousCursor >= page.cursor) {
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
            !value.worklet.versions.some((version) => version.version === value.targetVersion)
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

export function assertWorkletStage(value: unknown): asserts value is WorkletStage {
    if (!Value.Check(workletStageSchema, value)) {
        throw new Error("Worklet catalog returned an invalid staging result.");
    }
    assertWorkletOperationList(value.operations);
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
