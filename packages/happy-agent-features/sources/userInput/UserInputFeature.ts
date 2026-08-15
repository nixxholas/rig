import { createHash } from "node:crypto";

import {
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { deterministicStringify, type Context } from "@steve.kite/stdlib";

import {
    assertUserInputAnswer,
    assertUserInputOptions,
    assertUserInputRequest,
    isUserInputTerminal,
    MAX_USER_INPUT_ANSWER_CHARACTERS,
    MAX_USER_INPUT_CANCEL_REASON_CHARACTERS,
    MAX_USER_INPUT_CONTEXT_CHARACTERS,
    MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS,
    MAX_USER_INPUT_FINGERPRINT_LENGTH,
    MAX_USER_INPUT_OPTION_COUNT,
    MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS,
    MAX_USER_INPUT_OPTION_LABEL_CHARACTERS,
    MAX_USER_INPUT_OPERATION_ID_LENGTH,
    MAX_USER_INPUT_QUESTION_CHARACTERS,
    userInputAgentIdSchema,
    userInputAnswerSchema,
    userInputAskInputSchema,
    userInputAnswerInputSchema,
    userInputCancelInputSchema,
    userInputCompleteInputSchema,
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputEventIdSchema,
    userInputFingerprintSchema,
    userInputListQuerySchema,
    userInputOperationIdSchema,
    userInputPageSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputTimestampSchema,
    type UserInputAnswer,
    type UserInputAnswerInput,
    type UserInputAskInput,
    type UserInputCancelInput,
    type UserInputCompleteInput,
    type UserInputDetailPage,
    type UserInputDetailQuery,
    type UserInputListQuery,
    type UserInputPage,
    type UserInputRequest,
    type UserInputWaitInput,
} from "./UserInputRequest.js";
import {
    userInputContextSchema,
    userInputEventSchema,
    userInputFeatureListenerSchema,
    type UserInputEvent,
    type UserInputFeatureListener,
} from "./UserInputEvent.js";
import {
    assertUserInputMutationProof,
    assertUserInputMutationReceipt,
    assertUserInputPage,
    assertUserInputTransactionChange,
    assertUserInputVoidResult,
    userInputAuthorizationSchema,
    userInputMutationProofSchema,
    userInputMutationReceiptSchema,
    userInputPresencePolicySchema,
    userInputStoreSchema,
    type UserInputAuthorization,
    type UserInputAuthorizationAction,
    type UserInputMutationKind,
    type UserInputMutationProof,
    type UserInputMutationReceipt,
    type UserInputPresencePolicy,
    type UserInputStore,
    type UserInputTransactionChange,
} from "./UserInputStore.js";
import { userInputToolKV } from "./UserInputToolContext.js";
import { requestUserInputTool } from "./tools/request_user_input.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 8_000;
const DEFAULT_MAX_QUESTION_CHARACTERS = MAX_USER_INPUT_QUESTION_CHARACTERS;
const DEFAULT_MAX_CONTEXT_CHARACTERS = MAX_USER_INPUT_CONTEXT_CHARACTERS;
const DEFAULT_MAX_ANSWER_CHARACTERS = MAX_USER_INPUT_ANSWER_CHARACTERS;
const DEFAULT_MAX_OPTION_COUNT = MAX_USER_INPUT_OPTION_COUNT;
const DEFAULT_MAX_OPTION_LABEL_CHARACTERS = MAX_USER_INPUT_OPTION_LABEL_CHARACTERS;
const DEFAULT_MAX_OPTION_DESCRIPTION_CHARACTERS = MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS;
const DEFAULT_MAX_CANCEL_REASON_CHARACTERS = MAX_USER_INPUT_CANCEL_REASON_CHARACTERS;
const DEFAULT_MAX_DETAIL_PAGE_CHARACTERS = MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS;

const operationStateSchema = Type.Object(
    {
        operationId: userInputOperationIdSchema,
        fingerprint: Type.String({ maxLength: MAX_USER_INPUT_FINGERPRINT_LENGTH }),
    },
    { additionalProperties: false },
);

const voidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
export const userInputIdFactorySchema = Type.Function(
    [userInputContextSchema, userInputAgentIdSchema],
    Type.Union([userInputRequestIdSchema, Type.Promise(userInputRequestIdSchema)]),
);
export const userInputEventIdFactorySchema = Type.Function(
    [userInputContextSchema, userInputAgentIdSchema],
    Type.Union([userInputEventIdSchema, Type.Promise(userInputEventIdSchema)]),
);
export const userInputClockSchema = Type.Function(
    [userInputContextSchema, userInputAgentIdSchema],
    userInputTimestampSchema,
);

const boundedQuestionSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_QUESTION_CHARACTERS,
});
const boundedContextSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_CONTEXT_CHARACTERS,
});
const boundedAnswerSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_ANSWER_CHARACTERS,
});
const boundedOptionCountSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_OPTION_COUNT,
});
const boundedOptionLabelSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_OPTION_LABEL_CHARACTERS,
});
const boundedOptionDescriptionSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS,
});
const boundedReasonSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_USER_INPUT_CANCEL_REASON_CHARACTERS,
});

export const userInputFeatureOptionsSchema = Type.Object(
    {
        store: userInputStoreSchema,
        presence: Type.Optional(userInputPresencePolicySchema),
        authorization: Type.Optional(userInputAuthorizationSchema),
        idFactory: Type.Optional(userInputIdFactorySchema),
        eventIdFactory: Type.Optional(userInputEventIdFactorySchema),
        clock: Type.Optional(userInputClockSchema),
        listener: Type.Optional(userInputFeatureListenerSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: 100_000 }),
        ),
        onPostCommitError: Type.Optional(
            Type.Function(
                [userInputContextSchema, userInputEventSchema, Type.Unknown()],
                voidOrPromiseVoidSchema,
            ),
        ),
        maxQuestionCharacters: Type.Optional(boundedQuestionSchema),
        maxContextCharacters: Type.Optional(boundedContextSchema),
        maxAnswerCharacters: Type.Optional(boundedAnswerSchema),
        maxOptionCount: Type.Optional(boundedOptionCountSchema),
        maxOptionLabelCharacters: Type.Optional(boundedOptionLabelSchema),
        maxOptionDescriptionCharacters: Type.Optional(boundedOptionDescriptionSchema),
        maxCancelReasonCharacters: Type.Optional(boundedReasonSchema),
        maxDetailPageCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS }),
        ),
    },
    { additionalProperties: false },
);

export const userInputPostCommitErrorSchema = Type.Function(
    [userInputContextSchema, userInputEventSchema, Type.Unknown()],
    voidOrPromiseVoidSchema,
);

export type UserInputFeatureOptions = Static<typeof userInputFeatureOptionsSchema>;

type MutationOperation = {
    readonly kind: UserInputMutationKind;
    readonly operationId: string;
    readonly fingerprint: string;
};

type UserInputChange = UserInputTransactionChange;

/**
 * One shared user-input capability serves every agent. All durable state and all waiting belong
 * to the host store; this class only validates, serializes, and shapes the capability.
 */
export class UserInputFeature implements AgentFeature {
    readonly name = "userInput";

    readonly #store: UserInputStore;
    readonly #presence: UserInputPresencePolicy | undefined;
    readonly #authorization: UserInputAuthorization | undefined;
    readonly #idFactory: NonNullable<UserInputFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<UserInputFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<UserInputFeatureOptions["clock"]>;
    readonly #listener: UserInputFeatureListener | undefined;
    readonly #onPostCommitError: UserInputFeatureOptions["onPostCommitError"];
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #maxQuestionCharacters: number;
    readonly #maxContextCharacters: number;
    readonly #maxAnswerCharacters: number;
    readonly #maxOptionCount: number;
    readonly #maxOptionLabelCharacters: number;
    readonly #maxOptionDescriptionCharacters: number;
    readonly #maxCancelReasonCharacters: number;
    readonly #maxDetailPageCharacters: number;

    constructor(options: UserInputFeatureOptions) {
        const validated = validateOptions(options);
        this.#store = validated.store;
        this.#presence = validated.presence;
        this.#authorization = validated.authorization;
        this.#idFactory =
            validated.idFactory ??
            ((_ctx, _agentId) => globalThis.crypto.randomUUID().replaceAll("-", ""));
        this.#eventIdFactory =
            validated.eventIdFactory ??
            ((_ctx, _agentId) => globalThis.crypto.randomUUID().replaceAll("-", ""));
        this.#clock = validated.clock ?? ((_ctx, _agentId) => Date.now());
        this.#listener = validated.listener;
        this.#onPostCommitError = validated.onPostCommitError;
        this.#maxPageSize = validated.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = validated.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#maxQuestionCharacters =
            validated.maxQuestionCharacters ?? DEFAULT_MAX_QUESTION_CHARACTERS;
        this.#maxContextCharacters =
            validated.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS;
        this.#maxAnswerCharacters = validated.maxAnswerCharacters ?? DEFAULT_MAX_ANSWER_CHARACTERS;
        this.#maxOptionCount = validated.maxOptionCount ?? DEFAULT_MAX_OPTION_COUNT;
        this.#maxOptionLabelCharacters =
            validated.maxOptionLabelCharacters ?? DEFAULT_MAX_OPTION_LABEL_CHARACTERS;
        this.#maxOptionDescriptionCharacters =
            validated.maxOptionDescriptionCharacters ?? DEFAULT_MAX_OPTION_DESCRIPTION_CHARACTERS;
        this.#maxCancelReasonCharacters =
            validated.maxCancelReasonCharacters ?? DEFAULT_MAX_CANCEL_REASON_CHARACTERS;
        this.#maxDetailPageCharacters =
            validated.maxDetailPageCharacters ?? DEFAULT_MAX_DETAIL_PAGE_CHARACTERS;
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => {
        this.#assertAgentId(scope.agent.id);
        return [requestUserInputTool(this, scope.agent.id)];
    };

    async ask(ctx: Context, agentId: string, input: UserInputAskInput): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputAskInputSchema, input, "user input request");
        this.#assertAskBounds(input);
        const normalized = structuredClone(input);
        if (userInputToolKV(ctx) === undefined) {
            return await this.#askHost(ctx, agentId, normalized);
        }
        const requestId = await this.#callScopedId(ctx, agentId, "request.ask.id", "request");
        const operationId = await this.#operationId(
            ctx,
            agentId,
            "ask",
            requestId,
            normalized.operationId,
        );
        const fingerprint = this.#fingerprint("ask", agentId, {
            ...normalized,
            requestId,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, "ask", requestId, fingerprint);
        const change = await this.#commit(
            ctx,
            agentId,
            { kind: "ask", operationId, fingerprint },
            (txCtx) =>
                this.#decideAsk(
                    txCtx,
                    agentId,
                    normalized,
                    requestId,
                    operationId,
                    fingerprint,
                ),
        );
        return structuredClone(change.result);
    }

    async #askHost(
        ctx: Context,
        agentId: string,
        input: UserInputAskInput,
    ): Promise<UserInputRequest> {
        const operationId = input.operationId;
        if (operationId === undefined) {
            throw new Error("A host-facing user input ask must provide an operation identity.");
        }
        const change = await this.#commitDynamic(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readUnboundReceipt(txCtx, agentId, operationId);
            if (receipt !== undefined && receipt.kind !== "ask") {
                throw new Error(
                    `User input operation "${operationId}" was used for another mutation.`,
                );
            }
            const requestId =
                receipt === undefined
                    ? await this.#newIdentity(txCtx, agentId)
                    : receipt.result.id;
            const fingerprint = this.#fingerprint("ask", agentId, {
                ...input,
                requestId,
                operationId,
            });
            return await this.#decideAsk(
                txCtx,
                agentId,
                input,
                requestId,
                operationId,
                fingerprint,
            );
        });
        return structuredClone(change.result);
    }

    async #decideAsk(
        ctx: Context,
        agentId: string,
        input: UserInputAskInput,
        requestId: string,
        operationId: string,
        fingerprint: string,
    ): Promise<UserInputChange> {
        const receipt = await this.#readReceipt(ctx, agentId, {
            kind: "ask",
            operationId,
            fingerprint,
        });
        const current = await this.#readRequest(ctx, requestId);
        if (receipt !== undefined) {
            const result = await this.#replayAsk(
                ctx,
                agentId,
                receipt,
                current,
                input,
                requestId,
            );
            return this.#change("ask", operationId, agentId, result, false, []);
        }
        const orphanedProof = await this.#readProof(ctx, agentId, operationId);
        if (orphanedProof !== undefined) {
            throw new Error("User input request has an orphaned mutation proof.");
        }
        if (current !== undefined) {
            this.#assertSamePendingInput(current, input, requestId, agentId);
            const proof = this.#proof(
                "ask",
                operationId,
                agentId,
                fingerprint,
                requestId,
                current,
                current,
                false,
            );
            await this.#persistProofAndReceipt(ctx, proof, {
                kind: "ask",
                operationId,
                actingAgentId: agentId,
                fingerprint,
                changed: proof.changed,
                result: current,
            });
            return this.#change("ask", operationId, agentId, current, false, []);
        }
        const at = this.#now(ctx, agentId);
        const request: UserInputRequest = {
            id: requestId,
            askingAgentId: agentId,
            question: input.question,
            context: input.context,
            ...(input.options === undefined ? {} : { options: input.options }),
            ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
            status: "pending",
            createdAt: at,
            updatedAt: at,
        };
        this.#assertRequest(request);
        await this.#writeRequest(ctx, request);
        const persisted = await this.#readRequiredRequest(ctx, requestId);
        if (!sameValue(persisted, request)) {
            throw new Error("User input store substituted the requested request.");
        }
        const event = await this.#newEvent(ctx, agentId, "user_input_requested", persisted);
        await this.#announce(ctx, event);
        const proof = this.#proof(
            "ask",
            operationId,
            agentId,
            fingerprint,
            requestId,
            null,
            persisted,
            true,
        );
        await this.#persistProofAndReceipt(ctx, proof, {
            kind: "ask",
            operationId,
            actingAgentId: agentId,
            fingerprint,
            changed: proof.changed,
            result: persisted,
        });
        return this.#change("ask", operationId, agentId, persisted, true, [event]);
    }

    async wait(
        ctx: Context,
        agentId: string,
        inputOrRequestId: UserInputWaitInput | string,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        const input =
            typeof inputOrRequestId === "string"
                ? { requestId: inputOrRequestId }
                : inputOrRequestId;
        this.#assertInput(
            // The public wait accepts an omitted operation ID when its caller carries a durable
            // call-scoped AgentKV; the schema remains the single runtime source of truth.
            Type.Object(
                {
                    operationId: Type.Optional(userInputOperationIdSchema),
                    requestId: userInputRequestIdSchema,
                },
                { additionalProperties: false },
            ),
            input,
            "user input wait",
        );
        const operationId = await this.#operationId(
            ctx,
            agentId,
            "wait",
            input.requestId,
            input.operationId,
        );
        const fingerprint = this.#fingerprint("wait", agentId, {
            requestId: input.requestId,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, "wait", input.requestId, fingerprint);
        const initial = await this.#commit(
            ctx,
            agentId,
            { kind: "wait", operationId, fingerprint },
            async (txCtx) => {
                const current = await this.#readRequiredRequest(txCtx, input.requestId);
                await this.#authorize(txCtx, agentId, current.askingAgentId, "wait");
                const receipt = await this.#readReceipt(txCtx, agentId, {
                    kind: "wait",
                    operationId,
                    fingerprint,
                });
                if (receipt !== undefined) {
                    const proof = await this.#requireProof(txCtx, agentId, operationId, receipt);
                    this.#assertReceiptMatchesCurrent(receipt, proof, current);
                    return this.#change("wait", operationId, agentId, current, false, []);
                }
                const orphanedProof = await this.#readProof(txCtx, agentId, operationId);
                if (orphanedProof !== undefined) {
                    throw new Error("User input wait has an orphaned mutation proof.");
                }
                if (isUserInputTerminal(current)) {
                    const proof = this.#proof(
                        "wait",
                        operationId,
                        agentId,
                        fingerprint,
                        input.requestId,
                        current,
                        current,
                        false,
                    );
                    await this.#persistProofAndReceipt(txCtx, proof, {
                        kind: "wait",
                        operationId,
                        actingAgentId: agentId,
                        fingerprint,
                        changed: proof.changed,
                        result: current,
                    });
                    return this.#change("wait", operationId, agentId, current, false, []);
                }
                const now = this.#now(ctx, agentId);
                if (current.deadlineAt !== undefined && current.deadlineAt <= now) {
                    const timedOut = this.#terminalRequest(current, {
                        outcome: "timed_out",
                        deadlineAt: current.deadlineAt,
                    }, now);
                    await this.#writeRequest(txCtx, timedOut);
                    const event = await this.#newEvent(
                        txCtx,
                        agentId,
                        "user_input_completed",
                        timedOut,
                    );
                    await this.#announce(txCtx, event);
                    const proof = this.#proof(
                        "wait",
                        operationId,
                        agentId,
                        fingerprint,
                        input.requestId,
                        current,
                        timedOut,
                        true,
                    );
                    await this.#persistProofAndReceipt(txCtx, proof, {
                        kind: "wait",
                        operationId,
                        actingAgentId: agentId,
                        fingerprint,
                        changed: proof.changed,
                        result: timedOut,
                    });
                    return this.#change("wait", operationId, agentId, timedOut, true, [event]);
                }
                return this.#change("wait", operationId, agentId, current, false, []);
            },
        );
        if (initial.result.status !== "pending") return structuredClone(initial.result);
        const requestOwnerAgentId = initial.result.askingAgentId;

        if (this.#presence !== undefined) {
            const availableRaw: unknown = this.#presence.isAvailable(ctx, agentId);
            const available = await requireMaybePromise(
                availableRaw,
                "User input presence policy",
            );
            if (typeof available !== "boolean") {
                throw new Error("User input presence policy returned a non-boolean result.");
            }
            if (!available) {
                const away = await this.#settleWait(
                    ctx,
                    agentId,
                    input.requestId,
                    operationId,
                    fingerprint,
                    { outcome: "away" },
                );
                return structuredClone(away);
            }
        }

        // This is deliberately outside #commit: a host wait may suspend across process restarts.
        const waitedRaw: unknown = this.#store.wait(ctx, agentId, input.requestId);
        const waited = await requirePromise(waitedRaw, "User input durable wait");
        this.#assertRequest(waited);
        if (
            waited.id !== input.requestId ||
            waited.askingAgentId !== requestOwnerAgentId ||
            waited.status === "pending"
        ) {
            throw new Error("User input durable wait returned an invalid pending or foreign request.");
        }

        const settled = await this.#commit(
            ctx,
            agentId,
            { kind: "wait", operationId, fingerprint },
            async (txCtx) => {
                const current = await this.#readRequiredRequest(txCtx, input.requestId);
                await this.#authorize(txCtx, agentId, current.askingAgentId, "wait");
                if (current.askingAgentId !== requestOwnerAgentId) {
                    throw new Error("User input request owner changed while waiting.");
                }
                const receipt = await this.#readReceipt(txCtx, agentId, {
                    kind: "wait",
                    operationId,
                    fingerprint,
                });
                if (receipt !== undefined) {
                    const proof = await this.#requireProof(txCtx, agentId, operationId, receipt);
                    this.#assertReceiptMatchesCurrent(receipt, proof, current);
                    return this.#change("wait", operationId, agentId, current, false, []);
                }
                if (current.status === "pending") {
                    throw new Error("User input durable wait returned before the request settled.");
                }
                if (!sameValue(current, waited)) {
                    throw new Error("User input wait result disagrees with authoritative storage.");
                }
                const proof = this.#proof(
                    "wait",
                    operationId,
                    agentId,
                    fingerprint,
                    input.requestId,
                    current,
                    current,
                    false,
                );
                await this.#persistProofAndReceipt(txCtx, proof, {
                    kind: "wait",
                    operationId,
                    actingAgentId: agentId,
                    fingerprint,
                    changed: proof.changed,
                    result: current,
                });
                // The durable broker only wakes after another committed mutation settles the
                // request. That mutation already announced its event; this wait is a no-op.
                return this.#change("wait", operationId, agentId, current, false, []);
            },
        );
        return structuredClone(settled.result);
    }

    async answer(
        ctx: Context,
        agentId: string,
        input: UserInputAnswerInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputAnswerInputSchema, input, "user input answer");
        return await this.#answer(ctx, agentId, input);
    }

    async cancel(
        ctx: Context,
        agentId: string,
        input: UserInputCancelInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputCancelInputSchema, input, "user input cancellation");
        if (input.reason.length > this.#maxCancelReasonCharacters) {
            throw new Error("User input cancellation reason exceeds its configured bound.");
        }
        const operationId = await this.#operationId(
            ctx,
            agentId,
            "cancel",
            input.requestId,
            input.operationId,
        );
        const fingerprint = this.#fingerprint("cancel", agentId, {
            ...input,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, "cancel", input.requestId, fingerprint);
        const change = await this.#commit(
            ctx,
            agentId,
            { kind: "cancel", operationId, fingerprint },
            async (txCtx) => {
                const current = await this.#readRequiredRequest(txCtx, input.requestId);
                await this.#authorize(txCtx, agentId, current.askingAgentId, "cancel");
                const receipt = await this.#readReceipt(txCtx, agentId, {
                    kind: "cancel",
                    operationId,
                    fingerprint,
                });
                if (receipt !== undefined) {
                    const proof = await this.#requireProof(txCtx, agentId, operationId, receipt);
                    this.#assertReceiptMatchesCurrent(receipt, proof, current);
                    return this.#change("cancel", operationId, agentId, current, false, []);
                }
                if ((await this.#readProof(txCtx, agentId, operationId)) !== undefined) {
                    throw new Error("User input cancellation has an orphaned mutation proof.");
                }
                if (isUserInputTerminal(current)) {
                    const proof = this.#proof(
                        "cancel",
                        operationId,
                        agentId,
                        fingerprint,
                        input.requestId,
                        current,
                        current,
                        false,
                    );
                    await this.#persistProofAndReceipt(txCtx, proof, {
                        kind: "cancel",
                        operationId,
                        actingAgentId: agentId,
                        fingerprint,
                        changed: proof.changed,
                        result: current,
                    });
                    return this.#change("cancel", operationId, agentId, current, false, []);
                }
                const cancelled = this.#terminalRequest(
                    current,
                    { outcome: "cancelled", reason: input.reason },
                    this.#now(ctx, agentId),
                );
                await this.#writeRequest(txCtx, cancelled);
                const event = await this.#newEvent(txCtx, agentId, "user_input_cancelled", cancelled);
                await this.#announce(txCtx, event);
                const proof = this.#proof(
                    "cancel",
                    operationId,
                    agentId,
                    fingerprint,
                    input.requestId,
                    current,
                    cancelled,
                    true,
                );
                await this.#persistProofAndReceipt(txCtx, proof, {
                    kind: "cancel",
                    operationId,
                    actingAgentId: agentId,
                    fingerprint,
                    changed: proof.changed,
                    result: cancelled,
                });
                return this.#change("cancel", operationId, agentId, cancelled, true, [event]);
            },
        );
        return structuredClone(change.result);
    }

    async complete(
        ctx: Context,
        agentId: string,
        input: UserInputCompleteInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputCompleteInputSchema, input, "user input completion");
        const operationId = await this.#operationId(
            ctx,
            agentId,
            "complete",
            input.requestId,
            input.operationId,
        );
        const fingerprint = this.#fingerprint("complete", agentId, {
            ...input,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, "complete", input.requestId, fingerprint);
        const change = await this.#commit(
            ctx,
            agentId,
            { kind: "complete", operationId, fingerprint },
            async (txCtx) => {
                const current = await this.#readRequiredRequest(txCtx, input.requestId);
                await this.#authorize(txCtx, agentId, current.askingAgentId, "complete");
                const receipt = await this.#readReceipt(txCtx, agentId, {
                    kind: "complete",
                    operationId,
                    fingerprint,
                });
                if (receipt !== undefined) {
                    const proof = await this.#requireProof(txCtx, agentId, operationId, receipt);
                    this.#assertReceiptMatchesCurrent(receipt, proof, current);
                    return this.#change("complete", operationId, agentId, current, false, []);
                }
                if ((await this.#readProof(txCtx, agentId, operationId)) !== undefined) {
                    throw new Error("User input completion has an orphaned mutation proof.");
                }
                if (isUserInputTerminal(current)) {
                    if (input.outcome === "timed_out") {
                        this.#assertTimeout(current, input.deadlineAt, this.#now(ctx, agentId));
                    }
                    const proof = this.#proof(
                        "complete",
                        operationId,
                        agentId,
                        fingerprint,
                        input.requestId,
                        current,
                        current,
                        false,
                    );
                    await this.#persistProofAndReceipt(txCtx, proof, {
                        kind: "complete",
                        operationId,
                        actingAgentId: agentId,
                        fingerprint,
                        changed: proof.changed,
                        result: current,
                    });
                    return this.#change("complete", operationId, agentId, current, false, []);
                }
                const terminal = this.#terminalRequest(
                    current,
                    input,
                    this.#now(ctx, agentId),
                );
                await this.#writeRequest(txCtx, terminal);
                const eventType =
                    terminal.status === "cancelled"
                        ? "user_input_cancelled"
                        : "user_input_completed";
                const event = await this.#newEvent(
                    txCtx,
                    agentId,
                    eventType,
                    terminal,
                );
                await this.#announce(txCtx, event);
                const proof = this.#proof(
                    "complete",
                    operationId,
                    agentId,
                    fingerprint,
                    input.requestId,
                    current,
                    terminal,
                    true,
                );
                await this.#persistProofAndReceipt(txCtx, proof, {
                    kind: "complete",
                    operationId,
                    actingAgentId: agentId,
                    fingerprint,
                    changed: proof.changed,
                    result: terminal,
                });
                return this.#change("complete", operationId, agentId, terminal, true, [event]);
            },
        );
        return structuredClone(change.result);
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: UserInputListQuery = {},
    ): Promise<UserInputPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputListQuerySchema, query, "user input list query");
        const targetAgentId = query.askingAgentId ?? agentId;
        await this.#authorize(ctx, agentId, targetAgentId, "list");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`User input page limit cannot exceed ${String(this.#maxPageSize)}.`);
        }
        const requestedCursor = query.cursor ?? "0";
        assertSourceCursor(requestedCursor, "requests");
        const normalized = {
            ...structuredClone(query),
            cursor: requestedCursor,
            limit,
            askingAgentId: targetAgentId,
        };
        const raw: unknown = this.#store.listRequests(ctx, targetAgentId, normalized);
        const page = await requirePromise(raw, "User input store listRequests");
        assertUserInputPage(page);
        if (page.limit > limit || page.requests.length > limit) {
            throw new Error("User input store exceeded the requested page limit.");
        }
        assertSourceCursor(page.cursor, "requests");
        if (page.cursor !== requestedCursor) {
            throw new Error("User input store returned a page for a different source cursor.");
        }
        assertCursorProgress(page.nextCursor, page.cursor, page.requests.length, "requests");
        assertPreviousCursor(page.previousCursor, page.cursor, "requests");
        const seen = new Set<string>();
        for (const request of page.requests) {
            this.#assertRequest(request);
            if (seen.has(request.id)) throw new Error("User input store returned duplicate requests.");
            seen.add(request.id);
            if (request.askingAgentId !== targetAgentId) {
                throw new Error("User input store returned a request outside the requested agent.");
            }
            if (
                normalized.status === "pending" && request.status !== "pending" ||
                normalized.status === "terminal" && request.status === "pending"
            ) {
                throw new Error("User input store returned a request outside the requested filter.");
            }
            await this.#authorize(ctx, agentId, request.askingAgentId, "list");
        }
        return structuredClone(fitUserInputPage(page, this.#maxOutputCharacters));
    }

    async list(
        ctx: Context,
        agentId: string,
        query: UserInputListQuery = {},
    ): Promise<readonly UserInputRequest[]> {
        return (await this.listPage(ctx, agentId, query)).requests;
    }

    async get(
        ctx: Context,
        agentId: string,
        requestId: string,
    ): Promise<UserInputRequest | undefined> {
        this.#assertAgentId(agentId);
        this.#assertValue(userInputRequestIdSchema, requestId, "user input request ID");
        const request = await this.#readRequest(ctx, requestId);
        if (request === undefined) return undefined;
        await this.#authorize(ctx, agentId, request.askingAgentId, "get");
        return structuredClone(request);
    }

    async getPage(
        ctx: Context,
        agentId: string,
        requestId: string,
        query: UserInputDetailQuery = {},
    ): Promise<UserInputDetailPage> {
        this.#assertInput(userInputDetailQuerySchema, query, "user input detail query");
        const request = await this.get(ctx, agentId, requestId);
        if (request === undefined) {
            return { request: null, detail: "", cursor: 0, detailTotal: 0 };
        }
        const detail = requestDetail(request);
        const start = detailCursor(query);
        if (start > detail.length) throw new Error("User input detail cursor is past the detail.");
        if (query.limit !== undefined && query.detailLimit !== undefined) {
            throw new Error("User input detail query cannot specify both limit and detailLimit.");
        }
        const requestedLimit = query.limit ?? query.detailLimit ?? this.#maxDetailPageCharacters;
        if (requestedLimit > this.#maxDetailPageCharacters) {
            throw new Error("User input detail page exceeds its configured bound.");
        }
        const modelLimit = detailModelCharacterLimit(request, this.#maxOutputCharacters);
        const limit = Math.min(requestedLimit, modelLimit);
        const part = detail.slice(start, start + limit);
        const next = start + part.length < detail.length ? String(start + part.length) : undefined;
        const page: UserInputDetailPage = {
            request: structuredClone(request),
            detail: part,
            cursor: start,
            detailTotal: detail.length,
            ...(next === undefined ? {} : { nextCursor: next }),
        };
        this.#assertValue(userInputDetailPageSchema, page, "user input detail page");
        return page;
    }

    formatForModel(request: UserInputRequest): string {
        return formatUserInputForModel(request, this.#maxOutputCharacters);
    }

    formatPageForModel(page: UserInputPage): string {
        return formatUserInputPageForModel(page, this.#maxOutputCharacters);
    }

    formatDetailPageForModel(page: UserInputDetailPage): string {
        return formatUserInputDetailPageForModel(page, this.#maxOutputCharacters);
    }

    async #answer(
        ctx: Context,
        agentId: string,
        input: UserInputAnswerInput,
    ): Promise<UserInputRequest> {
        if (answerCharacters(input.answer) > this.#maxAnswerCharacters) {
            throw new Error("User input answer exceeds its configured bound.");
        }
        const operationId = await this.#operationId(
            ctx,
            agentId,
            "answer",
            input.requestId,
            input.operationId,
        );
        const fingerprint = this.#fingerprint("answer", agentId, {
            ...input,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, "answer", input.requestId, fingerprint);
        const change = await this.#commit(
            ctx,
            agentId,
            { kind: "answer", operationId, fingerprint },
            async (txCtx) => {
                const current = await this.#readRequiredRequest(txCtx, input.requestId);
                await this.#authorize(txCtx, agentId, current.askingAgentId, "answer");
                assertUserInputAnswer(input.answer, current.options);
                const receipt = await this.#readReceipt(txCtx, agentId, {
                    kind: "answer",
                    operationId,
                    fingerprint,
                });
                if (receipt !== undefined) {
                    const proof = await this.#requireProof(txCtx, agentId, operationId, receipt);
                    this.#assertReceiptMatchesCurrent(receipt, proof, current);
                    return this.#change("answer", operationId, agentId, current, false, []);
                }
                if ((await this.#readProof(txCtx, agentId, operationId)) !== undefined) {
                    throw new Error("User input answer has an orphaned mutation proof.");
                }
                if (isUserInputTerminal(current)) {
                    const proof = this.#proof(
                        "answer",
                        operationId,
                        agentId,
                        fingerprint,
                        input.requestId,
                        current,
                        current,
                        false,
                    );
                    await this.#persistProofAndReceipt(txCtx, proof, {
                        kind: "answer",
                        operationId,
                        actingAgentId: agentId,
                        fingerprint,
                        changed: proof.changed,
                        result: current,
                    });
                    return this.#change("answer", operationId, agentId, current, false, []);
                }
                const at = this.#now(ctx, agentId);
                const answered: UserInputRequest = {
                    ...current,
                    status: "answered",
                    answer: structuredClone(input.answer),
                    answeredAt: at,
                    updatedAt: at,
                };
                this.#assertRequest(answered);
                await this.#writeRequest(txCtx, answered);
                const persisted = await this.#readRequiredRequest(txCtx, input.requestId);
                if (!sameValue(persisted, answered)) {
                    throw new Error("User input store substituted the answer.");
                }
                const event = await this.#newEvent(
                    txCtx,
                    agentId,
                    "user_input_answered",
                    persisted,
                );
                await this.#announce(txCtx, event);
                const proof = this.#proof(
                    "answer",
                    operationId,
                    agentId,
                    fingerprint,
                    input.requestId,
                    current,
                    persisted,
                    true,
                );
                await this.#persistProofAndReceipt(txCtx, proof, {
                    kind: "answer",
                    operationId,
                    actingAgentId: agentId,
                    fingerprint,
                    changed: proof.changed,
                    result: persisted,
                });
                return this.#change("answer", operationId, agentId, persisted, true, [event]);
            },
        );
        return structuredClone(change.result);
    }

    async #settleWait(
        ctx: Context,
        agentId: string,
        requestId: string,
        operationId: string,
        fingerprint: string,
        outcome: { readonly outcome: "away" } | {
            readonly outcome: "timed_out";
            readonly deadlineAt: number;
        },
    ): Promise<UserInputRequest> {
        const change = await this.#commit(
            ctx,
            agentId,
            { kind: "wait", operationId, fingerprint },
            async (txCtx) => {
                const current = await this.#readRequiredRequest(txCtx, requestId);
                await this.#authorize(txCtx, agentId, current.askingAgentId, "wait");
                const receipt = await this.#readReceipt(txCtx, agentId, {
                    kind: "wait",
                    operationId,
                    fingerprint,
                });
                if (receipt !== undefined) {
                    const proof = await this.#requireProof(txCtx, agentId, operationId, receipt);
                    this.#assertReceiptMatchesCurrent(receipt, proof, current);
                    return this.#change("wait", operationId, agentId, current, false, []);
                }
                if (isUserInputTerminal(current)) {
                    const proof = this.#proof(
                        "wait",
                        operationId,
                        agentId,
                        fingerprint,
                        requestId,
                        current,
                        current,
                        false,
                    );
                    await this.#persistProofAndReceipt(txCtx, proof, {
                        kind: "wait",
                        operationId,
                        actingAgentId: agentId,
                        fingerprint,
                        changed: proof.changed,
                        result: current,
                    });
                    return this.#change("wait", operationId, agentId, current, false, []);
                }
                const terminal = this.#terminalRequest(current, outcome, this.#now(ctx, agentId));
                await this.#writeRequest(txCtx, terminal);
                const event = await this.#newEvent(
                    txCtx,
                    agentId,
                    "user_input_completed",
                    terminal,
                );
                await this.#announce(txCtx, event);
                const proof = this.#proof(
                    "wait",
                    operationId,
                    agentId,
                    fingerprint,
                    requestId,
                    current,
                    terminal,
                    true,
                );
                await this.#persistProofAndReceipt(txCtx, proof, {
                    kind: "wait",
                    operationId,
                    actingAgentId: agentId,
                    fingerprint,
                    changed: proof.changed,
                    result: terminal,
                });
                return this.#change("wait", operationId, agentId, terminal, true, [event]);
            },
        );
        return change.result;
    }

    async #commit(
        ctx: Context,
        actingAgentId: string,
        operation: MutationOperation,
        decide: (txCtx: Context) => Promise<UserInputChange>,
    ): Promise<UserInputChange> {
        const returned = await this.#commitDynamic(ctx, actingAgentId, async (txCtx) => {
            const decided = await decide(txCtx);
            if (
                decided.kind !== operation.kind ||
                decided.operationId !== operation.operationId ||
                decided.actingAgentId !== actingAgentId
            ) {
                throw new Error("User input transaction returned a different operation identity.");
            }
            return decided;
        });
        if (
            returned.kind !== operation.kind ||
            returned.operationId !== operation.operationId ||
            returned.actingAgentId !== actingAgentId
        ) {
            throw new Error("User input transaction returned a different operation identity.");
        }
        this.#assertValue(userInputFingerprintSchema, operation.fingerprint, "fingerprint");
        return returned;
    }

    async #commitDynamic(
        ctx: Context,
        actingAgentId: string,
        decide: (txCtx: Context) => Promise<UserInputChange>,
    ): Promise<UserInputChange> {
        let expected: UserInputChange | undefined;
        const raw: unknown = this.#store.transaction(
            ctx,
            actingAgentId,
            async (txCtx) => {
                const decided = await decide(txCtx);
                assertUserInputTransactionChange(decided);
                expected = cloneAndFreeze(decided);
                return decided;
            },
        );
        const returned = await requirePromise(raw, "User input store transaction");
        assertUserInputTransactionChange(returned);
        if (expected === undefined || !sameValue(returned, expected)) {
            throw new Error("User input store transaction returned a substituted change.");
        }
        return structuredClone(returned);
    }

    #change(
        kind: UserInputMutationKind,
        operationId: string,
        actingAgentId: string,
        result: UserInputRequest,
        changed: boolean,
        events: readonly UserInputEvent[],
    ): UserInputChange {
        const change: UserInputChange = {
            kind,
            operationId,
            actingAgentId,
            result: structuredClone(result),
            changed,
            events: events.map((event) => cloneAndFreeze(event)),
        };
        assertUserInputTransactionChange(change);
        return change;
    }

    async #newEvent(
        ctx: Context,
        actingAgentId: string,
        type: UserInputEvent["type"],
        request: UserInputRequest,
    ): Promise<UserInputEvent> {
        const eventIdRaw: unknown = this.#eventIdFactory(ctx, actingAgentId);
        const eventId = await requireMaybePromise(eventIdRaw, "User input event ID factory");
        this.#assertValue(userInputEventIdSchema, eventId, "event identity");
        const event = {
            eventId,
            at: this.#now(ctx, actingAgentId),
            actingAgentId,
            requestId: request.id,
            type,
            request: structuredClone(request),
        };
        this.#assertValue(userInputEventSchema, event, "user input event");
        return cloneAndFreeze(event as UserInputEvent);
    }

    async #announce(ctx: Context, event: UserInputEvent): Promise<void> {
        const frozen = cloneAndFreeze(event);
        await invokeVoid(
            this.#listener?.onEventTransactional?.(ctx, frozen),
            "User input transactional listener",
        );
        const registration: unknown = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, frozen),
        );
        if (registration !== undefined) {
            await requireMaybePromise(
                Promise.resolve(registration),
                "User input store afterCommit registration",
            );
            throw new Error("User input store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: UserInputEvent): Promise<void> {
        try {
            await invokeVoid(this.#listener?.onEvent?.(ctx, event), "User input post-commit listener");
        } catch (error: unknown) {
            try {
                await invokeVoid(
                    this.#onPostCommitError?.(ctx, event, error),
                    "User input post-commit error handler",
                );
            } catch {
                // Post-commit observation cannot undo durable state.
            }
        }
    }

    async #readRequest(ctx: Context, requestId: string): Promise<UserInputRequest | undefined> {
        const raw: unknown = this.#store.readRequest(ctx, requestId);
        const value = await requirePromise(raw, "User input store readRequest");
        if (value === undefined) return undefined;
        this.#assertRequest(value);
        if (value.id !== requestId) {
            throw new Error("User input store returned a request with a different identity.");
        }
        return structuredClone(value);
    }

    async #readRequiredRequest(ctx: Context, requestId: string): Promise<UserInputRequest> {
        const value = await this.#readRequest(ctx, requestId);
        if (value === undefined) throw new Error(`User input request "${requestId}" was not found.`);
        return value;
    }

    async #writeRequest(ctx: Context, request: UserInputRequest): Promise<void> {
        this.#assertRequest(request);
        const expected = structuredClone(request);
        const raw: unknown = this.#store.writeRequest(ctx, structuredClone(expected));
        assertUserInputVoidResult(
            await requirePromise(raw, "User input store writeRequest"),
            "store writeRequest",
        );
        const persisted = await this.#readRequiredRequest(ctx, request.id);
        if (!sameValue(persisted, expected)) {
            throw new Error("User input store substituted the persisted request.");
        }
    }

    async #readUnboundReceipt(
        ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<UserInputMutationReceipt | undefined> {
        const raw: unknown = this.#store.readReceipt(ctx, actingAgentId, operationId);
        const value = await requirePromise(raw, "User input store readReceipt");
        if (value === undefined) return undefined;
        assertUserInputMutationReceipt(value);
        this.#assertReceipt(value);
        if (value.operationId !== operationId || value.actingAgentId !== actingAgentId) {
            throw new Error("User input store returned a receipt for a different operation.");
        }
        return structuredClone(value);
    }

    async #readReceipt(
        ctx: Context,
        actingAgentId: string,
        operation: MutationOperation,
    ): Promise<UserInputMutationReceipt | undefined> {
        const raw: unknown = this.#store.readReceipt(
            ctx,
            actingAgentId,
            operation.operationId,
        );
        const value = await requirePromise(raw, "User input store readReceipt");
        if (value === undefined) return undefined;
        assertUserInputMutationReceipt(value);
        this.#assertReceipt(value);
        if (
            value.kind !== operation.kind ||
            value.operationId !== operation.operationId ||
            value.actingAgentId !== actingAgentId ||
            value.fingerprint !== operation.fingerprint
        ) {
            throw new Error(`User input operation "${operation.operationId}" was reused with different input.`);
        }
        return structuredClone(value);
    }

    async #writeReceipt(ctx: Context, receipt: UserInputMutationReceipt): Promise<void> {
        assertUserInputMutationReceipt(receipt);
        this.#assertReceipt(receipt);
        const expected = structuredClone(receipt);
        const raw: unknown = this.#store.writeReceipt(ctx, structuredClone(expected));
        assertUserInputVoidResult(
            await requirePromise(raw, "User input store writeReceipt"),
            "store writeReceipt",
        );
        const persistedRaw: unknown = this.#store.readReceipt(
            ctx,
            expected.actingAgentId,
            expected.operationId,
        );
        const persisted = await requirePromise(
            persistedRaw,
            "User input store readReceipt after write",
        );
        assertUserInputMutationReceipt(persisted);
        this.#assertReceipt(persisted);
        if (!sameValue(persisted, expected)) {
            throw new Error("User input store substituted the mutation receipt.");
        }
    }

    async #readProof(
        ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<UserInputMutationProof | undefined> {
        const raw: unknown = this.#store.readMutationProof(ctx, actingAgentId, operationId);
        const value = await requirePromise(raw, "User input store readMutationProof");
        if (value === undefined) return undefined;
        assertUserInputMutationProof(value);
        this.#assertProof(value);
        if (value.actingAgentId !== actingAgentId || value.operationId !== operationId) {
            throw new Error("User input store returned a proof for a different operation.");
        }
        return structuredClone(value);
    }

    async #writeProof(ctx: Context, proof: UserInputMutationProof): Promise<void> {
        assertUserInputMutationProof(proof);
        this.#assertProof(proof);
        const expected = structuredClone(proof);
        const existing = await this.#readProof(
            ctx,
            expected.actingAgentId,
            expected.operationId,
        );
        if (existing !== undefined) {
            if (!sameValue(existing, expected)) {
                throw new Error("User input mutation proof already exists with different content.");
            }
            return;
        }
        const raw: unknown = this.#store.writeMutationProof(
            ctx,
            structuredClone(expected),
            "if_absent",
        );
        assertUserInputVoidResult(
            await requirePromise(raw, "User input store writeMutationProof"),
            "store writeMutationProof",
        );
        const persistedRaw: unknown = this.#store.readMutationProof(
            ctx,
            expected.actingAgentId,
            expected.operationId,
        );
        const persisted = await requirePromise(
            persistedRaw,
            "User input store readMutationProof after write",
        );
        assertUserInputMutationProof(persisted);
        this.#assertProof(persisted);
        if (!sameValue(persisted, expected)) {
            throw new Error("User input store substituted the mutation proof.");
        }
    }

    async #persistProofAndReceipt(
        ctx: Context,
        proof: UserInputMutationProof,
        receipt: UserInputMutationReceipt,
    ): Promise<void> {
        await this.#writeProof(ctx, proof);
        await this.#writeReceipt(ctx, receipt);
    }

    async #requireProof(
        ctx: Context,
        actingAgentId: string,
        operationId: string,
        receipt: UserInputMutationReceipt,
    ): Promise<UserInputMutationProof> {
        const proof = await this.#readProof(ctx, actingAgentId, operationId);
        if (proof === undefined) {
            throw new Error("User input mutation receipt has no immutable proof.");
        }
        if (
            proof.kind !== receipt.kind ||
            proof.operationId !== receipt.operationId ||
            proof.actingAgentId !== receipt.actingAgentId ||
            proof.fingerprint !== receipt.fingerprint ||
            proof.changed !== receipt.changed ||
            proof.requestId !== receipt.result.id ||
            !sameValue(proof.result, receipt.result)
        ) {
            throw new Error("User input receipt and mutation proof disagree.");
        }
        return proof;
    }

    #proof(
        kind: UserInputMutationKind,
        operationId: string,
        actingAgentId: string,
        fingerprint: string,
        requestId: string,
        before: UserInputRequest | null,
        after: UserInputRequest,
        changed: boolean,
    ): UserInputMutationProof {
        const proof: UserInputMutationProof = {
            kind,
            operationId,
            actingAgentId,
            fingerprint,
            requestId,
            before: before === null ? null : structuredClone(before),
            after: structuredClone(after),
            changed,
            result: structuredClone(after),
        };
        this.#assertValue(userInputMutationProofSchema, proof, "mutation proof");
        return proof;
    }

    #assertReceiptMatchesCurrent(
        receipt: UserInputMutationReceipt,
        proof: UserInputMutationProof,
        current: UserInputRequest,
    ): void {
        if (receipt.kind === "ask") {
            if (
                current.id !== receipt.result.id ||
                current.askingAgentId !== receipt.result.askingAgentId ||
                current.question !== receipt.result.question ||
                current.context !== receipt.result.context ||
                !sameValue(current.options, receipt.result.options) ||
                current.deadlineAt !== receipt.result.deadlineAt ||
                current.createdAt !== receipt.result.createdAt
            ) {
                throw new Error("User input ask receipt disagrees with authoritative storage.");
            }
            return;
        }
        if (proof.after.id !== current.id || !sameValue(proof.after, current)) {
            throw new Error("User input receipt disagrees with authoritative storage.");
        }
    }

    async #replayAsk(
        ctx: Context,
        actingAgentId: string,
        receipt: UserInputMutationReceipt,
        current: UserInputRequest | undefined,
        input: UserInputAskInput,
        requestId: string,
    ): Promise<UserInputRequest> {
        if (
            receipt.result.id !== requestId ||
            receipt.result.askingAgentId !== actingAgentId ||
            receipt.result.question !== input.question ||
            receipt.result.context !== input.context ||
            !sameValue(receipt.result.options, input.options) ||
            receipt.result.deadlineAt !== input.deadlineAt
        ) {
            throw new Error("User input ask receipt belongs to different input.");
        }
        if (current === undefined) throw new Error("User input ask receipt has no request row.");
        const proof = await this.#requireProof(ctx, receipt.actingAgentId, receipt.operationId, receipt);
        this.#assertReceiptMatchesCurrent(receipt, proof, current);
        return current;
    }

    #assertSamePendingInput(
        current: UserInputRequest,
        input: UserInputAskInput,
        requestId: string,
        agentId: string,
    ): void {
        if (
            current.id !== requestId ||
            current.askingAgentId !== agentId ||
            current.status !== "pending" ||
            current.question !== input.question ||
            current.context !== input.context ||
            !sameValue(current.options, input.options) ||
            current.deadlineAt !== input.deadlineAt
        ) {
            throw new Error(`User input request "${requestId}" already exists with different values.`);
        }
    }

    #terminalRequest(
        current: UserInputRequest,
        input:
            | { readonly outcome: "away" }
            | { readonly outcome: "timed_out"; readonly deadlineAt: number }
            | { readonly outcome: "cancelled"; readonly reason: string },
        at: number,
    ): UserInputRequest {
        if (input.outcome === "cancelled") {
            if (input.reason.length > this.#maxCancelReasonCharacters) {
                throw new Error("User input cancellation reason exceeds its configured bound.");
            }
            const result: UserInputRequest = {
                ...current,
                status: "cancelled",
                reason: input.reason,
                cancelledAt: at,
                updatedAt: at,
            };
            this.#assertRequest(result);
            return result;
        }
        if (input.outcome === "timed_out") {
            this.#assertTimeout(current, input.deadlineAt, at);
            const result: UserInputRequest = {
                ...current,
                status: "timed_out",
                deadlineAt: current.deadlineAt,
                timedOutAt: at,
                updatedAt: at,
            };
            this.#assertRequest(result);
            return result;
        }
        const result: UserInputRequest = {
            ...current,
            status: "away",
            completedAt: at,
            updatedAt: at,
        };
        this.#assertRequest(result);
        return result;
    }

    #assertTimeout(
        current: UserInputRequest,
        deadlineAt: number,
        at: number,
    ): asserts current is UserInputRequest & { readonly deadlineAt: number } {
        this.#assertTime(deadlineAt, "timeout deadline");
        if (current.deadlineAt === undefined) {
            throw new Error("User input request has no timeout deadline.");
        }
        if (deadlineAt !== current.deadlineAt) {
            throw new Error("User input timeout deadline does not match the request deadline.");
        }
        if (at < current.deadlineAt) {
            throw new Error("User input timeout deadline has not elapsed.");
        }
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
        action: UserInputAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === targetAgentId) return;
        if (this.#authorization === undefined) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} user input for "${targetAgentId}".`,
            );
        }
        const raw: unknown = this.#authorization.authorize(
            ctx,
            actingAgentId,
            targetAgentId,
            action,
        );
        const allowed = await requireMaybePromise(raw, "User input authorization");
        if (typeof allowed !== "boolean") {
            throw new Error("User input authorization returned a non-boolean result.");
        }
        if (!allowed) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} user input for "${targetAgentId}".`,
            );
        }
    }

    async #operationId(
        ctx: Context,
        agentId: string,
        kind: UserInputMutationKind,
        requestId: string,
        requested: string | undefined,
    ): Promise<string> {
        if (requested !== undefined) {
            this.#assertValue(userInputOperationIdSchema, requested, "operation identity");
        }
        const key = `operation.${kind}.${requestId}`;
        const kv = userInputToolKV(ctx);
        if (kv === undefined) {
            if (requested === undefined) {
                throw new Error(
                    "A host-facing user input mutation must provide an operation identity.",
                );
            }
            return requested;
        }
        const state = await kv.update(ctx, key, async (current) => {
            if (current !== undefined) {
                this.#assertValue(operationStateSchema, current, "stored operation identity");
                const operation = current as Static<typeof operationStateSchema>;
                if (requested !== undefined && requested !== operation.operationId) {
                    throw new Error("The retry supplied a different user input operation identity.");
                }
                return operation;
            }
            const generated =
                requested ??
                (await this.#newOperationIdentity(ctx, agentId, kind, requestId));
            this.#assertValue(userInputOperationIdSchema, generated, "operation identity");
            return { operationId: generated, fingerprint: "" };
        });
        this.#assertValue(operationStateSchema, state, "stored operation identity");
        return (state as Static<typeof operationStateSchema>).operationId;
    }

    async #bindOperationFingerprint(
        ctx: Context,
        kind: UserInputMutationKind,
        requestId: string,
        fingerprint: string,
    ): Promise<void> {
        this.#assertValue(userInputFingerprintSchema, fingerprint, "fingerprint");
        const kv = userInputToolKV(ctx);
        if (kv === undefined) return;
        const key = `operation.${kind}.${requestId}`;
        await kv.update(ctx, key, (current) => {
            this.#assertValue(operationStateSchema, current, "stored operation identity");
            const operation = current as Static<typeof operationStateSchema>;
            if (operation.fingerprint !== "" && operation.fingerprint !== fingerprint) {
                throw new Error("The retry supplied different user input.");
            }
            return operation.fingerprint === "" ? { ...operation, fingerprint } : operation;
        });
    }

    async #callScopedId(
        ctx: Context,
        agentId: string,
        key: string,
        label: string,
    ): Promise<string> {
        const kv = userInputToolKV(ctx);
        if (kv === undefined) {
            throw new Error(
                `A host-facing user input ${label} mutation must provide an operation identity.`,
            );
        }
        const value = await kv.update(ctx, key, async (current) => {
            if (current !== undefined) {
                this.#assertValue(userInputRequestIdSchema, current, `stored ${label} identity`);
                return current;
            }
            const generated = await this.#newIdentity(ctx, agentId);
            this.#assertValue(userInputRequestIdSchema, generated, `${label} identity`);
            return generated;
        });
        this.#assertValue(userInputRequestIdSchema, value, `${label} identity`);
        return value as string;
    }

    async #newIdentity(ctx: Context, agentId: string): Promise<string> {
        const raw: unknown = this.#idFactory(ctx, agentId);
        const value = await requireMaybePromise(raw, "User input identity factory");
        this.#assertValue(userInputRequestIdSchema, value, "identity factory result");
        return value as string;
    }

    async #newOperationIdentity(
        ctx: Context,
        agentId: string,
        kind: UserInputMutationKind,
        requestId: string,
    ): Promise<string> {
        const generated = await this.#newIdentity(ctx, agentId);
        if (generated !== requestId) return generated;
        const prefixed = `op-${kind}-${generated}`.slice(
            0,
            MAX_USER_INPUT_OPERATION_ID_LENGTH,
        );
        this.#assertValue(userInputOperationIdSchema, prefixed, "operation identity");
        return prefixed;
    }

    #fingerprint(kind: UserInputMutationKind, agentId: string, input: unknown): string {
        const canonical = deterministicStringify({ kind, agentId, input });
        const fingerprint = createHash("sha256").update(canonical, "utf8").digest("hex");
        this.#assertValue(userInputFingerprintSchema, fingerprint, "fingerprint");
        return fingerprint;
    }

    #assertAskBounds(input: UserInputAskInput): void {
        if (input.question.length > this.#maxQuestionCharacters) {
            throw new Error("User input question exceeds its configured bound.");
        }
        if (input.context.length > this.#maxContextCharacters) {
            throw new Error("User input context exceeds its configured bound.");
        }
        if (input.options !== undefined) {
            if (input.options.choices.length > this.#maxOptionCount) {
                throw new Error("User input choices exceed their configured count bound.");
            }
            assertUserInputOptions(input.options);
            for (const choice of input.options.choices) {
                if (choice.label.length > this.#maxOptionLabelCharacters) {
                    throw new Error("User input option label exceeds its configured bound.");
                }
                if (choice.description.length > this.#maxOptionDescriptionCharacters) {
                    throw new Error("User input option description exceeds its configured bound.");
                }
            }
        }
        if (input.deadlineAt !== undefined) this.#assertTime(input.deadlineAt, "deadline");
    }

    #assertRequest(value: unknown): asserts value is UserInputRequest {
        assertUserInputRequest(value);
        const request = value;
        if (request.question.length > this.#maxQuestionCharacters) {
            throw new Error("Persisted user input question exceeds its configured bound.");
        }
        if (request.context.length > this.#maxContextCharacters) {
            throw new Error("Persisted user input context exceeds its configured bound.");
        }
        if (request.options !== undefined) {
            if (request.options.choices.length > this.#maxOptionCount) {
                throw new Error("Persisted user input choices exceed their configured bound.");
            }
            for (const choice of request.options.choices) {
                if (choice.label.length > this.#maxOptionLabelCharacters) {
                    throw new Error("Persisted user input option label exceeds its configured bound.");
                }
                if (choice.description.length > this.#maxOptionDescriptionCharacters) {
                    throw new Error(
                        "Persisted user input option description exceeds its configured bound.",
                    );
                }
            }
        }
        if (request.status === "answered" && answerCharacters(request.answer) > this.#maxAnswerCharacters) {
            throw new Error("Persisted user input answer exceeds its configured bound.");
        }
        if (request.status === "cancelled" && request.reason.length > this.#maxCancelReasonCharacters) {
            throw new Error("Persisted user input cancellation reason exceeds its configured bound.");
        }
    }

    #assertTime(value: number, label: string): void {
        this.#assertValue(userInputTimestampSchema, value, label);
    }

    #assertAgentId(value: string): void {
        this.#assertValue(userInputAgentIdSchema, value, "agent identity");
    }

    #assertInput<TSchema extends import("@sinclair/typebox").TSchema>(
        schema: TSchema,
        value: unknown,
        label: string,
    ): asserts value is Static<TSchema> {
        this.#assertValue(schema, value, label);
    }

    #assertValue(schema: import("@sinclair/typebox").TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}.`);
    }

    #now(ctx: Context, agentId: string): number {
        const value = this.#clock(ctx, agentId);
        this.#assertTime(value, "clock value");
        return value;
    }

    #assertReceipt(receipt: UserInputMutationReceipt): void {
        this.#assertValue(userInputMutationReceiptSchema, receipt, "mutation receipt");
        this.#assertRequest(receipt.result);
    }

    #assertProof(proof: UserInputMutationProof): void {
        this.#assertValue(userInputMutationProofSchema, proof, "mutation proof");
        if (proof.after.id !== proof.requestId) {
            throw new Error("User input mutation proof after state has a different request identity.");
        }
        this.#assertRequest(proof.after);
        if (proof.before !== null) {
            if (proof.before.id !== proof.requestId) {
                throw new Error(
                    "User input mutation proof before state has a different request identity.",
                );
            }
            this.#assertRequest(proof.before);
        }
        if (!sameValue(proof.after, proof.result)) {
            throw new Error("User input mutation proof result does not match its after state.");
        }
        if (proof.changed !== !sameValue(proof.before, proof.after)) {
            throw new Error("User input mutation proof changed flag is not authoritative.");
        }
        if (!proof.changed) return;
        if (proof.kind === "ask") {
            if (proof.before !== null || proof.after.status !== "pending") {
                throw new Error("User input mutation proof has an invalid ask transition.");
            }
            return;
        }
        if (
            proof.before === null ||
            proof.before.status !== "pending" ||
            !sameRequestIdentity(proof.before, proof.after)
        ) {
            throw new Error("User input mutation proof has an invalid transition.");
        }
        const validAfter =
            proof.kind === "answer"
                ? proof.after.status === "answered"
                : proof.kind === "cancel"
                  ? proof.after.status === "cancelled"
                  : proof.kind === "complete"
                    ? proof.after.status === "away" ||
                      proof.after.status === "cancelled" ||
                      proof.after.status === "timed_out"
                    : proof.after.status === "away" || proof.after.status === "timed_out";
        if (!validAfter) {
            throw new Error("User input mutation proof has an invalid terminal outcome.");
        }
    }
}

export function formatUserInputForModel(
    request: UserInputRequest,
    maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS,
): string {
    assertUserInputRequest(request);
    const identity = requestIdentityLine(request);
    const continuation =
        request.status === "answered"
            ? "More detail: call request_user_input for this request."
            : undefined;
    return fitModelText(
        identity,
        requestModelSupplement(request),
        maxOutputCharacters,
        continuation,
    );
}

export function formatUserInputPageForModel(
    page: UserInputPage,
    maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS,
): string {
    if (!Value.Check(userInputPageSchema, page)) {
        throw new Error("User input page is invalid.");
    }
    assertSourceCursor(page.cursor, "page");
    const visiblePage =
        page.requests.length === 0
            ? page
            : fitUserInputPage(page, maxOutputCharacters);
    const output = userInputPageText(visiblePage);
    if (output.length > maxOutputCharacters) {
        throw new Error("User input page cannot fit the configured model output budget.");
    }
    return output;
}

function fitUserInputPage(
    page: UserInputPage,
    maxOutputCharacters: number,
): UserInputPage {
    if (page.requests.length === 0) return page;
    assertSourceCursor(page.cursor, "page");
    const start = Number(page.cursor);
    const visible: UserInputRequest[] = [];
    for (const request of page.requests) {
        assertUserInputRequest(request);
        const candidateCount = visible.length + 1;
        const needsContinuation =
            page.nextCursor !== undefined || candidateCount < page.requests.length;
        const candidate: UserInputPage = {
            requests: [...visible, request],
            cursor: page.cursor,
            limit: candidateCount,
            ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
            ...(needsContinuation
                ? { nextCursor: String(start + candidateCount) }
                : {}),
        };
        if (userInputPageText(candidate).length > maxOutputCharacters) break;
        visible.push(request);
    }
    if (visible.length === 0) {
        throw new Error(
            "User input page cannot expose a complete request identity within the output budget.",
        );
    }
    const consumedAll = visible.length === page.requests.length;
    const nextCursor =
        consumedAll && page.nextCursor === undefined
            ? undefined
            : String(start + visible.length);
    return {
        requests: visible,
        cursor: page.cursor,
        limit: visible.length,
        ...(page.previousCursor === undefined ? {} : { previousCursor: page.previousCursor }),
        ...(nextCursor === undefined ? {} : { nextCursor }),
    };
}

function userInputPageText(page: UserInputPage): string {
    const lines =
        page.requests.length === 0
            ? ["No matching user input requests. Outcome: no matching requests."]
            : page.requests.map((request) => {
                  assertUserInputRequest(request);
                  return userInputRequestRow(request);
              });
    if (page.previousCursor !== undefined) {
        lines.push(`Earlier requests start at cursor ${page.previousCursor}.`);
    }
    if (page.nextCursor !== undefined) {
        lines.push(`More requests at cursor ${page.nextCursor}.`);
    }
    return lines.join("\n");
}

export function formatUserInputDetailPageForModel(
    page: UserInputDetailPage,
    maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS,
): string {
    if (!Value.Check(userInputDetailPageSchema, page)) {
        throw new Error("User input detail page is invalid.");
    }
    if (page.request === null) {
        const missing = "Request not found. Outcome: no matching request.";
        if (missing.length > maxOutputCharacters) {
            throw new Error("User input detail cannot fit the configured model output budget.");
        }
        return missing;
    }
    assertUserInputRequest(page.request);
    const identity = formatDetailIdentityLine(page.request);
    if (identity.length > maxOutputCharacters) {
        throw new Error("User input detail cannot fit the configured model output budget.");
    }

    let visibleCharacters = page.detail.length;
    for (;;) {
        const hasMore =
            page.nextCursor !== undefined ||
            page.cursor + visibleCharacters < page.detailTotal ||
            visibleCharacters < page.detail.length;
        const nextCursor = hasMore ? String(page.cursor + visibleCharacters) : undefined;
        const output = `${identity}${
            visibleCharacters === 0 ? "" : `\nDetail: ${page.detail.slice(0, visibleCharacters)}`
        }${nextCursor === undefined ? "" : `\nMore detail at cursor ${nextCursor}.`}`;
        if (output.length <= maxOutputCharacters) return output;
        if (visibleCharacters === 0) {
            const compact = `${identity}${
                nextCursor === undefined ? "" : `\nMore detail at cursor ${nextCursor}.`
            }`;
            if (compact.length <= maxOutputCharacters) return compact;
            return identity;
        }
        const excess = Math.max(1, output.length - maxOutputCharacters);
        visibleCharacters = Math.max(0, visibleCharacters - excess);
    }
}

export const formatForModel = formatUserInputForModel;
export const formatPageForModel = formatUserInputPageForModel;
export const formatDetailPageForModel = formatUserInputDetailPageForModel;

function requestIdentityLine(request: UserInputRequest): string {
    return `User input request ${request.id}. Outcome: ${formatOutcomeLabel(request)}.`;
}

function userInputRequestRow(request: UserInputRequest): string {
    return `${request.id} — Outcome: ${formatOutcomeLabel(request)}.`;
}

function formatOutcomeLabel(request: UserInputRequest): string {
    switch (request.status) {
        case "pending":
            return "Pending";
        case "answered":
            return "Answered";
        case "cancelled":
            return "Cancelled";
        case "away":
            return "Away";
        case "timed_out":
            return "Timed out";
    }
}

function requestModelSupplement(request: UserInputRequest): string {
    switch (request.status) {
        case "pending":
            return `Question: ${request.question}`;
        case "answered":
            return formatAnsweredModelSupplement(request.answer);
        case "cancelled":
            return `Cancellation reason: ${request.reason}`;
        case "away":
            return "The human is unavailable.";
        case "timed_out":
            return `The deadline ${String(request.deadlineAt)} has elapsed.`;
    }
}

function fitModelText(
    base: string,
    supplement: string,
    maxOutputCharacters: number,
    continuation: string | undefined = undefined,
): string {
    if (base.length > maxOutputCharacters) {
        throw new Error("User input result cannot fit the configured model output budget.");
    }
    if (base.length + 1 + supplement.length <= maxOutputCharacters) {
        return `${base} ${supplement}`;
    }
    const continuationText = continuation === undefined ? "" : ` ${continuation}`;
    const available =
        maxOutputCharacters - base.length - continuationText.length - 2;
    if (available > 0) {
        return `${base} ${supplement.slice(0, available).trimEnd()}…${continuationText}`;
    }
    if (continuationText.length > 0 && base.length + continuationText.length <= maxOutputCharacters) {
        return `${base}${continuationText}`;
    }
    const fallbackAvailable = maxOutputCharacters - base.length - 2;
    if (fallbackAvailable <= 0) return base;
    return `${base} ${supplement.slice(0, fallbackAvailable).trimEnd()}…`;
}

function detailModelCharacterLimit(request: UserInputRequest, maxOutputCharacters: number): number {
    const base = formatDetailIdentityLine(request);
    const continuation = "\nMore detail at cursor 200000.".length;
    return Math.max(1, maxOutputCharacters - base.length - "\nDetail: ".length - continuation);
}

function formatDetailIdentityLine(request: UserInputRequest): string {
    return `Request ${request.id}. Outcome: ${formatOutcomeLabel(request)}.`;
}

function requestDetail(request: UserInputRequest): string {
    const options =
        request.options === undefined
            ? ""
            : `\nOptions (${request.options.multiSelect ? "multiple" : "one"} selection):\n${request.options.choices
                  .map((choice) => `- ${choice.label}: ${choice.description}`)
                  .join("\n")}`;
    return `Question: ${request.question}\n\nOutcome: ${formatOutcomeLabel(
        request,
    )}.${requestOutcomeDetail(request)}\n\nContext:\n${request.context}${options}`;
}

function requestOutcomeDetail(request: UserInputRequest): string {
    switch (request.status) {
        case "pending":
            return "";
        case "answered":
            return `\nAnswer: ${formatAnswer(request.answer)}`;
        case "cancelled":
            return `\nCancellation reason: ${request.reason}`;
        case "away":
            return "\nThe human is unavailable.";
        case "timed_out":
            return `\nTimeout deadline: ${String(request.deadlineAt)}${
                request.timedOutAt === undefined
                    ? ""
                    : `\nTimed out at: ${String(request.timedOutAt)}`
            }`;
    }
}

function formatAnswer(answer: UserInputAnswer): string {
    if (typeof answer === "string") return answer;
    const text = answer.text === undefined ? "" : answer.text;
    const selected = formatSelectedOptions(answer.selectedOptions);
    if (selected === undefined) return text;
    return text.length === 0 ? selected : `${selected} Explanation: ${text}`;
}

function formatAnsweredModelSupplement(answer: UserInputAnswer): string {
    if (typeof answer === "string") return `Answer: ${answer}`;
    const selection = formatSelectedOptions(answer.selectedOptions);
    const text = answer.text;
    if (selection === undefined) return `Answer: ${text ?? ""}`;
    return text === undefined
        ? `Answer: ${selection}`
        : `Answer: ${selection} Explanation: ${text}`;
}

function formatSelectedOptions(selectedOptions: readonly string[] | undefined): string | undefined {
    return selectedOptions === undefined
        ? undefined
        : `Selected options: ${selectedOptions.join(", ")}.`;
}

function answerCharacters(answer: UserInputAnswer): number {
    if (typeof answer === "string") return answer.length;
    return (
        (answer.text?.length ?? 0) +
        (answer.selectedOptions?.reduce((total, value) => total + value.length, 0) ?? 0)
    );
}

function detailCursor(query: UserInputDetailQuery): number {
    if (query.cursor !== undefined && query.detailOffset !== undefined) {
        throw new Error("User input detail query cannot specify both cursor and detailOffset.");
    }
    const raw = query.cursor ?? (query.detailOffset === undefined ? undefined : String(query.detailOffset));
    if (raw === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new Error("User input detail cursor must be a decimal offset.");
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw new Error("User input detail cursor is too large.");
    return parsed;
}

function assertSourceCursor(cursor: string | undefined, label: string): void {
    if (cursor === undefined) return;
    if (!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
        throw new Error(`User input ${label} cursor is not a valid decimal source position.`);
    }
}

function assertCursorProgress(
    nextCursor: string | undefined,
    requestedCursor: string | undefined,
    itemCount: number,
    label: string,
): void {
    if (nextCursor === undefined) return;
    if (!/^(0|[1-9][0-9]*)$/.test(nextCursor)) {
        throw new Error(`User input ${label} cursor is not a decimal source position.`);
    }
    const next = Number(nextCursor);
    const current = requestedCursor === undefined ? 0 : Number(requestedCursor);
    if (!Number.isSafeInteger(next) || !Number.isSafeInteger(current) || next <= current) {
        throw new Error(`User input ${label} page cursor does not make progress.`);
    }
    if (next !== current + itemCount) {
        throw new Error(`User input ${label} page cursor skipped returned identities.`);
    }
}

function assertPreviousCursor(
    previousCursor: string | undefined,
    requestedCursor: string | undefined,
    label: string,
): void {
    const current = requestedCursor === undefined ? 0 : Number(requestedCursor);
    if (previousCursor === undefined) {
        if (current > 0) {
            throw new Error(
                `User input ${label} page beyond the beginning must expose a previous cursor.`,
            );
        }
        return;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(previousCursor)) {
        throw new Error(`User input ${label} previous cursor is not a decimal source position.`);
    }
    const previous = Number(previousCursor);
    if (
        !Number.isSafeInteger(previous) ||
        !Number.isSafeInteger(current) ||
        current === 0 ||
        previous >= current
    ) {
        throw new Error(`User input ${label} previous cursor did not move backwards.`);
    }
}

function sameValue(left: unknown, right: unknown): boolean {
    if (left === undefined || right === undefined) return left === right;
    return deterministicStringify(left) === deterministicStringify(right);
}

function sameRequestIdentity(left: UserInputRequest, right: UserInputRequest): boolean {
    return (
        left.id === right.id &&
        left.askingAgentId === right.askingAgentId &&
        left.question === right.question &&
        left.context === right.context &&
        sameValue(left.options, right.options) &&
        left.deadlineAt === right.deadlineAt &&
        left.createdAt === right.createdAt
    );
}

function cloneAndFreeze<ValueType>(value: ValueType): ValueType {
    return deepFreeze(structuredClone(value));
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object") return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

async function requirePromise<ValueType>(value: unknown, label: string): Promise<ValueType> {
    if (!(value instanceof Promise)) {
        throw new Error(`${label} must return a Promise.`);
    }
    try {
        return (await value) as ValueType;
    } catch (error: unknown) {
        throw new Error(`${label} failed: ${safeErrorMessage(error)}`, { cause: error });
    }
}

async function requireMaybePromise<ValueType>(
    value: ValueType | Promise<ValueType>,
    label: string,
): Promise<ValueType> {
    try {
        return await value;
    } catch (error: unknown) {
        throw new Error(`${label} failed: ${safeErrorMessage(error)}`, { cause: error });
    }
}

async function invokeVoid(value: void | Promise<void> | undefined, label: string): Promise<void> {
    if (value === undefined) return;
    const result = await requireMaybePromise(value, label);
    if (result !== undefined) throw new Error(`${label} must resolve to undefined.`);
}

function safeErrorMessage(error: unknown): string {
    try {
        if (error instanceof Error && error.message.length <= 500) return error.message;
        const text = String(error);
        return text.length <= 500 ? text : text.slice(0, 500);
    } catch {
        return "unknown error";
    }
}

function validateOptions(options: unknown): UserInputFeatureOptions {
    if (options === null || typeof options !== "object") {
        throw new Error("User input feature options are invalid.");
    }
    const source = options as Record<string, unknown>;
    const store = source.store;
    const view: Record<string, unknown> = {
        ...source,
        store: methodView(store, [
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
        ]),
    };
    if (source.presence !== undefined) {
        view.presence = methodView(source.presence, ["isAvailable"]);
    }
    if (source.authorization !== undefined) {
        view.authorization = methodView(source.authorization, ["authorize"]);
    }
    if (source.listener !== undefined) {
        view.listener = methodView(source.listener, ["onEventTransactional", "onEvent"]);
    }
    if (!Value.Check(userInputFeatureOptionsSchema, view)) {
        throw new Error("User input feature options are invalid.");
    }
    return options as UserInputFeatureOptions;
}

function methodView(value: unknown, names: readonly string[]): unknown {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    const source = value as Record<string, (...args: never[]) => unknown>;
    const isPlain =
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null;
    const view: Record<string, unknown> = isPlain ? { ...source } : {};
    for (const name of names) {
        if (typeof source[name] === "function") {
            view[name] = (...args: never[]) => source[name]!.apply(value, args);
        }
    }
    return view;
}
