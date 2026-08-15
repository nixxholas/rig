import {
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    assertUserInputAnswer,
    assertUserInputOptions,
    assertUserInputRequest,
    isUserInputTerminal,
    MAX_USER_INPUT_ANSWER_CHARACTERS,
    MAX_USER_INPUT_CANCEL_REASON_CHARACTERS,
    MAX_USER_INPUT_CONTEXT_CHARACTERS,
    MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS,
    MAX_USER_INPUT_OPTION_COUNT,
    MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS,
    MAX_USER_INPUT_OPTION_LABEL_CHARACTERS,
    MAX_USER_INPUT_QUESTION_CHARACTERS,
    userInputAgentIdSchema,
    userInputAnswerInputSchema,
    userInputAskInputSchema,
    userInputCancelInputSchema,
    userInputCompleteInputSchema,
    userInputDetailPageSchema,
    userInputDetailQuerySchema,
    userInputEventIdSchema,
    userInputListQuerySchema,
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
    userInputModuleListenerSchema,
    type UserInputEvent,
    type UserInputModuleListener,
} from "./UserInputEvent.js";
import {
    assertUserInputPage,
    assertUserInputVoidResult,
    userInputAuthorizationSchema,
    userInputBrokerSchema,
    userInputPresencePolicySchema,
    type UserInputAuthorization,
    type UserInputAuthorizationAction,
    type UserInputBroker,
    type UserInputPresencePolicy,
    type UserInputStore,
} from "./UserInputStore.js";
import { createSqliteUserInputStorage, userInputMigrations } from "./SqliteUserInputStorage.js";
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

export const userInputModuleOptionsSchema = Type.Object(
    {
        broker: userInputBrokerSchema,
        presence: Type.Optional(userInputPresencePolicySchema),
        authorization: Type.Optional(userInputAuthorizationSchema),
        idFactory: Type.Optional(userInputIdFactorySchema),
        eventIdFactory: Type.Optional(userInputEventIdFactorySchema),
        clock: Type.Optional(userInputClockSchema),
        listener: Type.Optional(userInputModuleListenerSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        maxOutputCharacters: Type.Optional(Type.Integer({ minimum: 256, maximum: 100_000 })),
        onPostCommitError: Type.Optional(
            Type.Function(
                [userInputContextSchema, userInputEventSchema, Type.Unknown()],
                voidOrPromiseVoidSchema,
            ),
        ),
        maxQuestionCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_QUESTION_CHARACTERS }),
        ),
        maxContextCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_CONTEXT_CHARACTERS }),
        ),
        maxAnswerCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_ANSWER_CHARACTERS }),
        ),
        maxOptionCount: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_OPTION_COUNT }),
        ),
        maxOptionLabelCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_OPTION_LABEL_CHARACTERS }),
        ),
        maxOptionDescriptionCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_OPTION_DESCRIPTION_CHARACTERS }),
        ),
        maxCancelReasonCharacters: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_USER_INPUT_CANCEL_REASON_CHARACTERS }),
        ),
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

export type UserInputModuleOptions = Static<typeof userInputModuleOptionsSchema>;

/**
 * One shared user-input capability serves every agent. Request rows are the only durable
 * module state.
 */
export class UserInputModule implements AgentModule {
    readonly name = "userInput";
    readonly migrations = userInputMigrations;

    readonly #store: UserInputStore;
    readonly #broker: UserInputBroker;
    readonly #presence: UserInputPresencePolicy | undefined;
    readonly #authorization: UserInputAuthorization | undefined;
    readonly #idFactory: NonNullable<UserInputModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<UserInputModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<UserInputModuleOptions["clock"]>;
    readonly #listener: UserInputModuleListener | undefined;
    readonly #onPostCommitError: UserInputModuleOptions["onPostCommitError"];
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

    constructor(options: UserInputModuleOptions) {
        const validated = validateOptions(options);
        this.#store = createSqliteUserInputStorage();
        this.#broker = validated.broker;
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

    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
        this.#assertAgentId(scope.agent.id);
        return [requestUserInputTool(this, scope.agent.id)];
    };

    async ask(
        ctx: Context,
        agentId: string,
        input: UserInputAskInput,
        requestId?: string,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputAskInputSchema, input, "user input request");
        this.#assertAskBounds(input);
        const id = requestId ?? await this.#newIdentity(ctx, agentId);
        this.#assertValue(userInputRequestIdSchema, id, "request identity");
        const request = await ctx.inTx((txCtx) =>
            this.#createOrResume(txCtx, agentId, id, structuredClone(input)),
        );
        return structuredClone(request);
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
        this.#assertValue(
            Type.Object({ requestId: userInputRequestIdSchema }, { additionalProperties: false }),
            input,
            "user input wait",
        );
        const current = await this.#readRequiredRequest(ctx, input.requestId);
        await this.#authorize(ctx, agentId, current.askingAgentId, "wait");
        if (isUserInputTerminal(current)) return structuredClone(current);

        const immediate = await this.#immediateWaitOutcome(ctx, agentId, current);
        if (immediate !== undefined) {
            const request = await ctx.inTx((txCtx) =>
                this.#settlePending(txCtx, agentId, input.requestId, immediate),
            );
            return structuredClone(request);
        }

        const waited = await this.#waitOutsideTransaction(ctx, agentId, input.requestId);
        const authoritative = await this.#readRequiredRequest(ctx, input.requestId);
        await this.#authorize(ctx, agentId, authoritative.askingAgentId, "wait");
        this.#assertWaitResult(authoritative, waited, current.askingAgentId);
        return structuredClone(authoritative);
    }

    async answer(
        ctx: Context,
        agentId: string,
        input: UserInputAnswerInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputAnswerInputSchema, input, "user input answer");
        if (answerCharacters(input.answer) > this.#maxAnswerCharacters) {
            throw new Error("User input answer exceeds its configured bound.");
        }
        const request = await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredRequest(txCtx, input.requestId);
            await this.#authorize(txCtx, agentId, current.askingAgentId, "answer");
            assertUserInputAnswer(input.answer, current.options);
            if (isUserInputTerminal(current)) {
                return current;
            }
            const at = this.#now(ctx, agentId);
            const answered: UserInputRequest = {
                ...current,
                status: "answered",
                answer: structuredClone(input.answer),
                answeredAt: at,
                updatedAt: at,
            };
            return await this.#persistTransition(
                txCtx,
                agentId,
                "user_input_answered",
                answered,
            );
        });
        return structuredClone(request);
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
        const request = await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredRequest(txCtx, input.requestId);
            await this.#authorize(txCtx, agentId, current.askingAgentId, "cancel");
            if (isUserInputTerminal(current)) {
                return current;
            }
            const cancelled = this.#terminalRequest(
                current,
                { outcome: "cancelled", reason: input.reason },
                this.#now(ctx, agentId),
            );
            return await this.#persistTransition(
                txCtx,
                agentId,
                "user_input_cancelled",
                cancelled,
            );
        });
        return structuredClone(request);
    }

    async complete(
        ctx: Context,
        agentId: string,
        input: UserInputCompleteInput,
    ): Promise<UserInputRequest> {
        this.#assertAgentId(agentId);
        this.#assertInput(userInputCompleteInputSchema, input, "user input completion");
        const request = await ctx.inTx(async (txCtx) => {
            const current = await this.#readRequiredRequest(txCtx, input.requestId);
            await this.#authorize(txCtx, agentId, current.askingAgentId, "complete");
            if (isUserInputTerminal(current)) {
                if (input.outcome === "timed_out") {
                    this.#assertTimeout(current, input.deadlineAt, this.#now(ctx, agentId));
                }
                return current;
            }
            const terminal = this.#terminalRequest(current, input, this.#now(ctx, agentId));
            return await this.#persistTransition(
                txCtx,
                agentId,
                terminal.status === "cancelled"
                    ? "user_input_cancelled"
                    : "user_input_completed",
                terminal,
            );
        });
        return structuredClone(request);
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
        const page = await this.#store.listRequests(ctx, targetAgentId, normalized);
        assertUserInputPage(page);
        if (page.limit > limit || page.requests.length > limit) {
            throw new Error("User input store exceeded the requested page limit.");
        }
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
                (normalized.status === "pending" && request.status !== "pending") ||
                (normalized.status === "terminal" && request.status === "pending")
            ) {
                throw new Error("User input store returned a request outside the requested filter.");
            }
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
        const limit = Math.min(
            requestedLimit,
            detailModelCharacterLimit(request, this.#maxOutputCharacters),
        );
        const part = detail.slice(start, start + limit);
        const page: UserInputDetailPage = {
            request: structuredClone(request),
            detail: part,
            cursor: start,
            detailTotal: detail.length,
            ...(start + part.length < detail.length
                ? { nextCursor: String(start + part.length) }
                : {}),
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

    async #createOrResume(
        ctx: Context,
        agentId: string,
        requestId: string,
        input: UserInputAskInput,
    ): Promise<UserInputRequest> {
        const current = await this.#readRequest(ctx, requestId);
        if (current !== undefined) {
            this.#assertSameRequest(current, input, requestId, agentId);
            return current;
        }
        const at = this.#now(ctx, agentId);
        const request: UserInputRequest = {
            id: requestId,
            askingAgentId: agentId,
            question: input.question,
            context: input.context,
            ...(input.options === undefined ? {} : { options: structuredClone(input.options) }),
            ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
            status: "pending",
            createdAt: at,
            updatedAt: at,
        };
        this.#assertRequest(request);
        await this.#writeRequest(ctx, request);
        const event = await this.#newEvent(ctx, agentId, "user_input_requested", request);
        await this.#announce(ctx, event);
        return request;
    }

    async #settlePending(
        ctx: Context,
        agentId: string,
        requestId: string,
        outcome: { readonly outcome: "away" } | {
            readonly outcome: "timed_out";
            readonly deadlineAt: number;
        },
    ): Promise<UserInputRequest> {
        const current = await this.#readRequiredRequest(ctx, requestId);
        await this.#authorize(ctx, agentId, current.askingAgentId, "wait");
        if (isUserInputTerminal(current)) {
            return current;
        }
        const terminal = this.#terminalRequest(current, outcome, this.#now(ctx, agentId));
        return await this.#persistTransition(
            ctx,
            agentId,
            "user_input_completed",
            terminal,
        );
    }

    async #persistTransition(
        ctx: Context,
        agentId: string,
        eventType: UserInputEvent["type"],
        request: UserInputRequest,
    ): Promise<UserInputRequest> {
        this.#assertRequest(request);
        await this.#writeRequest(ctx, request);
        const event = await this.#newEvent(ctx, agentId, eventType, request);
        await this.#announce(ctx, event);
        return request;
    }

    async #newEvent(
        ctx: Context,
        actingAgentId: string,
        type: UserInputEvent["type"],
        request: UserInputRequest,
    ): Promise<UserInputEvent> {
        const eventId = await this.#eventIdFactory(ctx, actingAgentId);
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
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, frozen));
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
        const value = await this.#store.readRequest(ctx, requestId);
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
        assertUserInputVoidResult(
            await this.#store.writeRequest(ctx, structuredClone(request)),
            "store writeRequest",
        );
    }

    async #waitOutsideTransaction(
        ctx: Context,
        agentId: string,
        requestId: string,
    ): Promise<UserInputRequest> {
        const waited = await this.#broker.wait(ctx, agentId, requestId);
        this.#assertRequest(waited);
        if (!isUserInputTerminal(waited)) {
            throw new Error("User input broker returned a pending request.");
        }
        return structuredClone(waited);
    }

    async #immediateWaitOutcome(
        ctx: Context,
        agentId: string,
        request: Extract<UserInputRequest, { status: "pending" }>,
    ): Promise<
        | { readonly outcome: "away" }
        | { readonly outcome: "timed_out"; readonly deadlineAt: number }
        | undefined
    > {
        const now = this.#now(ctx, agentId);
        if (request.deadlineAt !== undefined && request.deadlineAt <= now) {
            return { outcome: "timed_out", deadlineAt: request.deadlineAt };
        }
        if (this.#presence === undefined) return undefined;
        const available = await this.#presence.isAvailable(ctx, agentId);
        if (typeof available !== "boolean") {
            throw new Error("User input presence policy returned a non-boolean result.");
        }
        return available ? undefined : { outcome: "away" };
    }

    #assertWaitResult(
        current: UserInputRequest,
        waited: UserInputRequest,
        askingAgentId: string,
    ): void {
        if (
            current.id !== waited.id ||
            current.askingAgentId !== askingAgentId ||
            !isUserInputTerminal(current) ||
            !sameValue(current, waited)
        ) {
            throw new Error("User input wait result disagrees with authoritative storage.");
        }
    }

    #terminalRequest(
        current: Extract<UserInputRequest, { status: "pending" }>,
        outcome: UserInputCompleteInput extends infer _Input
            ? { readonly outcome: "away" }
                | { readonly outcome: "timed_out"; readonly deadlineAt: number }
                | { readonly outcome: "cancelled"; readonly reason: string }
            : never,
        at: number,
    ): UserInputRequest {
        if (outcome.outcome === "away") {
            return { ...current, status: "away", completedAt: at, updatedAt: at };
        }
        if (outcome.outcome === "cancelled") {
            return {
                ...current,
                status: "cancelled",
                reason: outcome.reason,
                cancelledAt: at,
                updatedAt: at,
            };
        }
        this.#assertTimeout(current, outcome.deadlineAt, at);
        return { ...current, status: "timed_out", timedOutAt: at, updatedAt: at };
    }

    #assertTimeout(
        current: UserInputRequest,
        deadlineAt: number,
        now: number,
    ): asserts current is UserInputRequest & { readonly deadlineAt: number } {
        if (current.deadlineAt !== deadlineAt) {
            throw new Error("User input timeout deadline does not match the request.");
        }
        if (now < deadlineAt) throw new Error("User input request has not reached its deadline.");
    }

    #assertSameRequest(
        current: UserInputRequest,
        input: UserInputAskInput,
        requestId: string,
        agentId: string,
    ): void {
        if (
            current.id !== requestId ||
            current.askingAgentId !== agentId ||
            current.question !== input.question ||
            current.context !== input.context ||
            !sameValue(current.options, input.options) ||
            current.deadlineAt !== input.deadlineAt
        ) {
            throw new Error(`User input request "${requestId}" belongs to different input.`);
        }
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        askingAgentId: string,
        action: UserInputAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === askingAgentId) return;
        const allowed =
            this.#authorization === undefined
                ? false
                : await this.#authorization.authorize(
                    ctx,
                    actingAgentId,
                    askingAgentId,
                    action,
                );
        if (typeof allowed !== "boolean") {
            throw new Error("User input authorization returned a non-boolean result.");
        }
        if (!allowed) throw new Error("User input access is not authorized.");
    }

    async #newIdentity(ctx: Context, agentId: string): Promise<string> {
        const value = await this.#idFactory(ctx, agentId);
        this.#assertValue(userInputRequestIdSchema, value, "request identity");
        return value;
    }

    #assertAskBounds(input: UserInputAskInput): void {
        if (input.question.length > this.#maxQuestionCharacters) {
            throw new Error("User input question exceeds its configured bound.");
        }
        if (input.context.length > this.#maxContextCharacters) {
            throw new Error("User input context exceeds its configured bound.");
        }
        assertUserInputOptions(input.options);
        if (input.options === undefined) return;
        if (input.options.choices.length > this.#maxOptionCount) {
            throw new Error("User input options exceed their configured count.");
        }
        for (const choice of input.options.choices) {
            if (choice.label.length > this.#maxOptionLabelCharacters) {
                throw new Error("User input option label exceeds its configured bound.");
            }
            if (choice.description.length > this.#maxOptionDescriptionCharacters) {
                throw new Error("User input option description exceeds its configured bound.");
            }
        }
    }

    #assertAgentId(agentId: string): void {
        this.#assertValue(userInputAgentIdSchema, agentId, "agent identity");
    }

    #assertRequest(value: unknown): asserts value is UserInputRequest {
        assertUserInputRequest(value);
    }

    #assertInput<Schema extends TSchema>(
        schema: Schema,
        value: unknown,
        label: string,
    ): asserts value is Static<Schema> {
        this.#assertValue(schema, value, label);
    }

    #assertValue(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}.`);
    }

    #now(ctx: Context, agentId: string): number {
        const value = this.#clock(ctx, agentId);
        this.#assertValue(userInputTimestampSchema, value, "clock value");
        return value;
    }
}

export function formatUserInputForModel(
    request: UserInputRequest,
    maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS,
): string {
    assertUserInputRequest(request);
    const output = [
        `Request ${request.id}: ${request.question}`,
        `Status: ${formatOutcomeLabel(request)}`,
        requestModelSupplement(request),
    ]
        .filter((line): line is string => line !== undefined && line.length > 0)
        .join("\n");
    return fitText(output, maxOutputCharacters);
}

export function formatUserInputPageForModel(
    page: UserInputPage,
    maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS,
): string {
    if (!Value.Check(userInputPageSchema, page)) throw new Error("User input page is invalid.");
    if (page.requests.length === 0) return "No user input requests.";
    const lines: string[] = [];
    for (const request of page.requests) {
        const line = `${request.id} · ${formatOutcomeLabel(request)} · ${request.question}`;
        if ([...lines, line].join("\n").length > maxOutputCharacters) break;
        lines.push(line);
    }
    if (lines.length === 0) throw new Error("User input page cannot fit the output budget.");
    if (lines.length < page.requests.length || page.nextCursor !== undefined) {
        lines.push(`Next cursor: ${page.nextCursor ?? String(Number(page.cursor) + lines.length)}`);
    }
    return fitText(lines.join("\n"), maxOutputCharacters);
}

export function formatUserInputDetailPageForModel(
    page: UserInputDetailPage,
    maxOutputCharacters = DEFAULT_OUTPUT_CHARACTERS,
): string {
    if (!Value.Check(userInputDetailPageSchema, page)) {
        throw new Error("User input detail page is invalid.");
    }
    if (page.request === null) return "User input request not found.";
    const continuation =
        page.nextCursor === undefined ? "" : `\nNext cursor: ${page.nextCursor}`;
    return fitText(
        `${formatUserInputForModel(page.request, maxOutputCharacters)}\n${page.detail}${continuation}`,
        maxOutputCharacters,
    );
}

export const formatForModel = formatUserInputForModel;
export const formatPageForModel = formatUserInputPageForModel;
export const formatDetailPageForModel = formatUserInputDetailPageForModel;

function fitUserInputPage(page: UserInputPage, maxOutputCharacters: number): UserInputPage {
    const requests: UserInputRequest[] = [];
    for (const request of page.requests) {
        const candidate = { ...page, requests: [...requests, request] };
        if (formatUserInputPageForModel(candidate, maxOutputCharacters).length > maxOutputCharacters) {
            break;
        }
        requests.push(request);
    }
    if (page.requests.length > 0 && requests.length === 0) {
        throw new Error("User input page cannot fit the configured model output budget.");
    }
    const start = Number(page.cursor);
    return {
        ...page,
        requests,
        ...(requests.length < page.requests.length
            ? { nextCursor: String(start + requests.length) }
            : {}),
    };
}

function requestDetail(request: UserInputRequest): string {
    const lines = [`Context:\n${request.context}`];
    if (request.options !== undefined) {
        lines.push(
            `Options:\n${request.options.choices
                .map((choice) => `- ${choice.label}: ${choice.description}`)
                .join("\n")}`,
        );
    }
    if (request.status === "answered") lines.push(`Answer:\n${formatAnswer(request.answer)}`);
    if (request.status === "cancelled") lines.push(`Cancellation reason:\n${request.reason}`);
    return lines.join("\n\n");
}

function requestModelSupplement(request: UserInputRequest): string | undefined {
    if (request.status === "answered") return `Answer: ${formatAnswer(request.answer)}`;
    if (request.status === "cancelled") return `Reason: ${request.reason}`;
    return undefined;
}

function formatOutcomeLabel(request: UserInputRequest): string {
    switch (request.status) {
        case "pending":
            return "Waiting for an answer";
        case "answered":
            return "Answered";
        case "cancelled":
            return "Cancelled";
        case "away":
            return "User unavailable";
        case "timed_out":
            return "Timed out";
    }
}

function formatAnswer(answer: UserInputAnswer): string {
    if (typeof answer === "string") return answer;
    const selected =
        answer.selectedOptions === undefined
            ? undefined
            : `Selected: ${answer.selectedOptions.join(", ")}`;
    return [selected, answer.text].filter((value): value is string => value !== undefined).join("\n");
}

function answerCharacters(answer: UserInputAnswer): number {
    if (typeof answer === "string") return answer.length;
    return (answer.text?.length ?? 0) +
        (answer.selectedOptions?.reduce((sum, option) => sum + option.length, 0) ?? 0);
}

function detailCursor(query: UserInputDetailQuery): number {
    if (query.cursor !== undefined && query.detailOffset !== undefined) {
        throw new Error("User input detail query cannot specify both cursor and detailOffset.");
    }
    const raw = query.cursor ?? String(query.detailOffset ?? 0);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("User input detail cursor is invalid.");
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error("User input detail cursor is too large.");
    return value;
}

function detailModelCharacterLimit(
    request: UserInputRequest,
    maxOutputCharacters: number,
): number {
    return Math.max(1, maxOutputCharacters - formatUserInputForModel(request).length - 64);
}

function assertSourceCursor(cursor: string | undefined, label: string): void {
    if (cursor === undefined || !/^(0|[1-9][0-9]*)$/.test(cursor)) {
        throw new Error(`User input ${label} cursor is invalid.`);
    }
}

function assertCursorProgress(
    nextCursor: string | undefined,
    cursor: string,
    count: number,
    label: string,
): void {
    if (nextCursor === undefined) return;
    assertSourceCursor(nextCursor, label);
    if (Number(nextCursor) !== Number(cursor) + count) {
        throw new Error(`User input ${label} next cursor does not match the returned rows.`);
    }
}

function assertPreviousCursor(
    previousCursor: string | undefined,
    cursor: string,
    label: string,
): void {
    if (previousCursor === undefined) return;
    assertSourceCursor(previousCursor, label);
    if (Number(previousCursor) >= Number(cursor)) {
        throw new Error(`User input ${label} previous cursor does not move backward.`);
    }
}

function fitText(text: string, maxCharacters: number): string {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
        throw new Error("User input output character bound is invalid.");
    }
    if (text.length <= maxCharacters) return text;
    if (maxCharacters <= 1) return "…".slice(0, maxCharacters);
    return `${text.slice(0, maxCharacters - 1)}…`;
}

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function cloneAndFreeze<Value>(value: Value): Value {
    return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

async function invokeVoid(value: void | Promise<void> | undefined, label: string): Promise<void> {
    if (value === undefined) return;
    const result = await value;
    if (result !== undefined) throw new Error(`${label} must resolve to undefined.`);
}

function validateOptions(options: unknown): UserInputModuleOptions {
    if (options === null || typeof options !== "object") {
        throw new Error("User input module options are invalid.");
    }
    const source = options as Record<string, unknown>;
    const view: Record<string, unknown> = {
        ...source,
        broker: methodView(source.broker, ["wait"]),
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
    if (!Value.Check(userInputModuleOptionsSchema, view)) {
        throw new Error("User input module options are invalid.");
    }
    return options as UserInputModuleOptions;
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