import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    userInputAgentIdSchema,
    userInputAskInputSchema,
    userInputFingerprintSchema,
    userInputListQuerySchema,
    userInputOperationIdSchema,
    userInputPageSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputTerminalRequestSchema,
    type UserInputPage,
    type UserInputRequest,
} from "./UserInputRequest.js";
import { userInputContextSchema, userInputEventSchema } from "./UserInputEvent.js";

export const userInputMutationKindSchema = Type.Union([
    Type.Literal("ask"),
    Type.Literal("answer"),
    Type.Literal("cancel"),
    Type.Literal("complete"),
    Type.Literal("wait"),
]);

export const userInputMutationRequestSchema = Type.Object(
    {
        kind: userInputMutationKindSchema,
        operationId: userInputOperationIdSchema,
        actingAgentId: userInputAgentIdSchema,
        fingerprint: userInputFingerprintSchema,
    },
    { additionalProperties: false },
);

export const userInputMutationReceiptSchema = Type.Object(
    {
        kind: userInputMutationKindSchema,
        operationId: userInputOperationIdSchema,
        actingAgentId: userInputAgentIdSchema,
        fingerprint: userInputFingerprintSchema,
        changed: Type.Boolean(),
        result: userInputRequestSchema,
    },
    { additionalProperties: false },
);

/**
 * Receipts are replay data and carry `changed` only as a cross-check. The proof independently
 * records the before/after decision, so a mutable receipt cannot invent historical state.
 */
export const userInputMutationProofSchema = Type.Object(
    {
        kind: userInputMutationKindSchema,
        operationId: userInputOperationIdSchema,
        actingAgentId: userInputAgentIdSchema,
        fingerprint: userInputFingerprintSchema,
        requestId: userInputRequestIdSchema,
        before: Type.Union([userInputRequestSchema, Type.Null()]),
        after: userInputRequestSchema,
        changed: Type.Boolean(),
        result: userInputRequestSchema,
    },
    { additionalProperties: false },
);

export const userInputTransactionChangeSchema = Type.Object(
    {
        kind: userInputMutationKindSchema,
        operationId: userInputOperationIdSchema,
        actingAgentId: userInputAgentIdSchema,
        result: userInputRequestSchema,
        changed: Type.Boolean(),
        events: Type.Array(userInputEventSchema, { maxItems: 1 }),
    },
    { additionalProperties: false },
);

export const userInputAfterCommitCallbackSchema = Type.Function(
    [userInputContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

/** The only permitted mutation for an immutable proof is an insert that fails on an existing key. */
export const userInputMutationProofWriteModeSchema = Type.Literal("if_absent");

/**
 * The presence policy is intentionally structural. UserInputFeature does not import or
 * understand PresenceFeature; the host decides whether the human is currently reachable.
 */
export const userInputPresencePolicySchema = Type.Object(
    {
        isAvailable: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema],
            Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
        ),
    },
    { additionalProperties: false },
);

export const userInputAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("wait"),
    Type.Literal("answer"),
    Type.Literal("cancel"),
    Type.Literal("complete"),
]);

export const userInputAuthorizationSchema = Type.Object(
    {
        authorize: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputAgentIdSchema,
                userInputAuthorizationActionSchema,
            ],
            Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
        ),
    },
    { additionalProperties: false },
);

/** Narrow view of the host-owned durable wait operation for hosts that keep it separately named. */
export const userInputBrokerSchema = Type.Object(
    {
        wait: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputRequestIdSchema,
            ],
            Type.Promise(userInputTerminalRequestSchema),
        ),
    },
    { additionalProperties: false },
);

/**
 * The host owns every durable row, receipt, proof, transaction, and wait broker. The `wait`
 * operation may suspend for days and must return only after the host has durably settled.
 */
export const userInputStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                Type.Function(
                    [userInputContextSchema],
                    Type.Promise(userInputTransactionChangeSchema),
                ),
            ],
            Type.Promise(userInputTransactionChangeSchema),
        ),
        afterCommit: Type.Function(
            [userInputContextSchema, userInputAfterCommitCallbackSchema],
            Type.Void(),
        ),
        readRequest: Type.Function(
            [userInputContextSchema, userInputRequestIdSchema],
            Type.Promise(Type.Union([userInputRequestSchema, Type.Undefined()])),
        ),
        writeRequest: Type.Function(
            [userInputContextSchema, userInputRequestSchema],
            Type.Promise(Type.Void()),
        ),
        listRequests: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema, userInputListQuerySchema],
            Type.Promise(userInputPageSchema),
        ),
        readReceipt: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputOperationIdSchema,
            ],
            Type.Promise(Type.Union([userInputMutationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [userInputContextSchema, userInputMutationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        readMutationProof: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputOperationIdSchema,
            ],
            Type.Promise(Type.Union([userInputMutationProofSchema, Type.Undefined()])),
        ),
        /**
         * Insert one immutable proof. The adapter must atomically reject an existing proof key,
         * even when the incoming value is schema-valid; overwriting a proof destroys replay
         * evidence.
         */
        writeMutationProof: Type.Function(
            [
                userInputContextSchema,
                userInputMutationProofSchema,
                userInputMutationProofWriteModeSchema,
            ],
            Type.Promise(Type.Void()),
        ),
        wait: Type.Function(
            [
                userInputContextSchema,
                userInputAgentIdSchema,
                userInputRequestIdSchema,
            ],
            Type.Promise(userInputTerminalRequestSchema),
        ),
    },
    { additionalProperties: false },
);

export type UserInputMutationKind = Static<typeof userInputMutationKindSchema>;
export type UserInputMutationRequest = Static<typeof userInputMutationRequestSchema>;
export type UserInputMutationReceipt = Static<typeof userInputMutationReceiptSchema>;
export type UserInputMutationProof = Static<typeof userInputMutationProofSchema>;
export type UserInputMutationProofWriteMode = Static<
    typeof userInputMutationProofWriteModeSchema
>;
export type UserInputTransactionChange = Static<typeof userInputTransactionChangeSchema>;
export type UserInputPresencePolicy = Static<typeof userInputPresencePolicySchema>;
export type UserInputAuthorizationAction = Static<typeof userInputAuthorizationActionSchema>;
export type UserInputAuthorization = Static<typeof userInputAuthorizationSchema>;
export type UserInputBroker = Static<typeof userInputBrokerSchema>;
export type UserInputStore = Static<typeof userInputStoreSchema>;

export function assertUserInputStore(value: unknown): asserts value is UserInputStore {
    if (!Value.Check(userInputStoreSchema, userInputStoreMethodView(value))) {
        throw new Error("User input feature received an invalid host store.");
    }
}

export function assertUserInputTransactionChange(
    value: unknown,
): asserts value is UserInputTransactionChange {
    if (!Value.Check(userInputTransactionChangeSchema, value)) {
        throw new Error("User input store transaction returned an invalid change.");
    }
}

export function assertUserInputMutationReceipt(
    value: unknown,
): asserts value is UserInputMutationReceipt {
    if (!Value.Check(userInputMutationReceiptSchema, value)) {
        throw new Error("User input store returned an invalid mutation receipt.");
    }
}

export function assertUserInputMutationProof(
    value: unknown,
): asserts value is UserInputMutationProof {
    if (!Value.Check(userInputMutationProofSchema, value)) {
        throw new Error("User input store returned an invalid mutation proof.");
    }
}

export function assertUserInputPage(value: unknown): asserts value is UserInputPage {
    if (!Value.Check(userInputPageSchema, value)) {
        throw new Error("User input store returned an invalid request page.");
    }
}

export function assertUserInputVoidResult(value: unknown, operation: string): void {
    if (value !== undefined) {
        throw new Error(`User input ${operation} must return undefined.`);
    }
}

export function assertUserInputMutationRequest(
    value: unknown,
): asserts value is UserInputMutationRequest {
    if (!Value.Check(userInputMutationRequestSchema, value)) {
        throw new Error("User input mutation request is invalid.");
    }
}

/** Keep this import in the public contract so host adapters can type their request input directly. */
export type UserInputStoreAskInput = Static<typeof userInputAskInputSchema>;

export function assertUserInputContext(value: unknown): asserts value is Context {
    if (!Value.Check(userInputContextSchema, value)) {
        throw new Error("User input context is invalid.");
    }
}

function userInputStoreMethodView(value: unknown): unknown {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return value;
    }
    const source = value as Record<string, unknown>;
    const names = [
        "transaction",
        "afterCommit",
        "readRequest",
        "writeRequest",
        "listRequests",
        "readReceipt",
        "writeReceipt",
        "readMutationProof",
        "writeMutationProof",
        "wait",
    ];
    const isPlain =
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null;
    const view: Record<string, unknown> = isPlain ? { ...source } : {};
    for (const name of names) {
        if (typeof source[name] === "function") {
            view[name] = (...args: readonly unknown[]) =>
                (source[name] as (...inner: unknown[]) => unknown).apply(value, [...args]);
        }
    }
    return view;
}