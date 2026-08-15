import {
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    secretAgentIdSchema,
    secretAttachReferenceResultSchema,
    secretAttachInputSchema,
    secretIdSchema,
    secretListInputSchema,
    secretListQuerySchema,
    secretRegistrationInputSchema,
    secretRegistrationSchema,
    secretScopeRefSchema,
    secretUpdateInputSchema,
    type SecretAgentId,
    type SecretAttachReferenceResult,
    type SecretAttachInput,
    type SecretAttachment,
    type SecretHostEnvironment,
    type SecretId,
    type SecretListInput,
    type SecretListQuery,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretRegistrationInput,
    type SecretScopeRef,
    type SecretUpdateInput,
} from "./Secret.js";
import {
    secretAuthorizationSchema,
    secretAuthorizationOperationSchema,
    secretResolverSchema,
    assertSecretAttachment,
    assertSecretHostEnvironment,
    assertSecretPage,
    assertSecretReference,
    assertSecretStoreMutationResult,
    type SecretAuthorization,
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./SecretStore.js";
import { createSecretDatabase, secretsMigrations, type SecretDatabase } from "./SecretDatabase.js";
import {
    secretContextSchema,
    secretEventIdSchema,
    secretEventSchema,
    secretEventTimestampSchema,
    secretModuleListenerSchema,
    type SecretEvent,
    type SecretModuleListener,
} from "./SecretEvent.js";
import { attachSecretTool } from "./tools/attach_secret.js";
import { detachSecretTool } from "./tools/detach_secret.js";
import { listSecretsTool } from "./tools/list_secrets.js";
import { referenceSecretTool } from "./tools/reference_secret.js";

const DEFAULT_MAX_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 12_000;
const MAX_OUTPUT_CHARACTERS = 100_000;
const MAX_SECRET_LIST_ITEMS = 256;

const idFactorySchema = Type.Function(
    [secretContextSchema, secretAgentIdSchema],
    Type.Union([secretIdSchema, Type.Promise(secretIdSchema)]),
);

const eventFactorySchema = Type.Function(
    [secretContextSchema, secretAgentIdSchema],
    Type.Union([secretEventIdSchema, Type.Promise(secretEventIdSchema)]),
);

const clockSchema = Type.Function([], secretEventTimestampSchema);
const postCommitErrorSchema = Type.Function(
    [secretContextSchema, secretEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Unknown())]),
);

const secretModuleOptionsSchema = Type.Object(
    {
        resolveForHost: Type.Optional(secretResolverSchema),
        idFactory: Type.Optional(idFactorySchema),
        eventIdFactory: Type.Optional(eventFactorySchema),
        clock: Type.Optional(clockSchema),
        listener: Type.Optional(secretModuleListenerSchema),
        authorize: Type.Optional(secretAuthorizationSchema),
        onPostCommitError: Type.Optional(postCommitErrorSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({
                minimum: 256,
                maximum: MAX_OUTPUT_CHARACTERS,
            }),
        ),
    },
    { additionalProperties: false },
);

/** Public constructor validation schema. */
export { secretModuleOptionsSchema };
export type SecretsModuleOptions = Static<typeof secretModuleOptionsSchema>;

type SecretIdFactory = Static<typeof idFactorySchema>;
type SecretEventFactory = Static<typeof eventFactorySchema>;
type SecretClock = Static<typeof clockSchema>;
type SecretPostCommitError = Static<typeof postCommitErrorSchema>;

type SecretChange<Result> = {
    readonly result: Result;
    readonly event?: SecretEvent | undefined;
};

/**
 * Module-owned secret metadata and attachment management.
 *
 * Secret values are never returned to the model. `resolveForHost` remains an optional trusted-host
 * capability and is intentionally not exposed as a model tool.
 *
 * Every mutation simply overwrites: calling `register`, `update`, `attach`, or `detach` again with
 * the same or a different value applies again and succeeds. There is no retry ledger.
 */
export class SecretsModule implements AgentModule {
    readonly name = "secrets";
    readonly migrations = secretsMigrations;

    readonly #store: SecretDatabase;
    readonly #resolver: SecretsModuleOptions["resolveForHost"];
    readonly #idFactory: SecretIdFactory;
    readonly #eventIdFactory: SecretEventFactory;
    readonly #clock: SecretClock;
    readonly #listener: SecretModuleListener | undefined;
    readonly #authorize: SecretAuthorization | undefined;
    readonly #onPostCommitError: SecretPostCommitError | undefined;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;

    constructor(options: SecretsModuleOptions = {}) {
        assertSecretsModuleOptions(options);
        this.#store = createSecretDatabase();
        this.#resolver = options.resolveForHost;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#authorize = options.authorize;
        this.#onPostCommitError = options.onPostCommitError;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        if (!Value.Check(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE }), this.#maxPageSize)) {
            throw new Error("Secrets max page size is invalid.");
        }
        if (
            !Value.Check(
                Type.Integer({ minimum: 256, maximum: MAX_OUTPUT_CHARACTERS }),
                this.#maxOutputCharacters,
            )
        ) {
            throw new Error("Secrets max model output size is invalid.");
        }
    }

    /** Return a bounded page of safe secret metadata, optionally filtered by an opaque scope. */
    async list(
        ctx: Context,
        actingAgentId: string,
        query: SecretListInput = {},
    ): Promise<SecretPage> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertInput(secretListInputSchema, query, "list query");
        const normalized = this.#listQuery(query);
        return await ctx.inTx(async (txCtx) => {
            await this.#authorizeOperation(txCtx, actingAgentId, "list", query.scopeRef);
            const page = await this.#readPage(txCtx, actingAgentId, normalized);
            for (let count = page.secrets.length; count >= 1; count -= 1) {
                const candidate: SecretPage = {
                    secrets: page.secrets.slice(0, count),
                    limit: page.limit,
                    ...(count < page.secrets.length
                        ? { nextCursor: (normalized.cursor ?? 0) + count }
                        : page.nextCursor === undefined
                          ? {}
                          : { nextCursor: page.nextCursor }),
                };
                if (this.#formatPage(candidate, true).length <= this.#maxOutputCharacters) {
                    return candidate;
                }
            }
            if (page.secrets.length === 0) return page;
            throw new Error("Secret metadata cannot fit a complete model-facing page.");
        });
    }

    /** Read one safe reference. This method never returns registration values. */
    async reference(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
    ): Promise<SecretReference | undefined> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        await this.#authorizeOperation(ctx, actingAgentId, "reference");
        const value = await this.#reference(ctx, actingAgentId, secretId);
        if (value === undefined) return undefined;
        const reference = this.#normalizeReference(value);
        if (reference.id !== secretId) {
            throw new Error("Secret store returned a different reference identity.");
        }
        return reference;
    }

    /** Register a host-owned secret and return safe metadata only. A repeated call overwrites. */
    async register(
        ctx: Context,
        actingAgentId: string,
        input: SecretRegistrationInput,
    ): Promise<SecretReference> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertInput(secretRegistrationInputSchema, input, "registration");
        await this.#authorizeOperation(ctx, actingAgentId, "register");
        const normalizedInput = normalizeRegistrationInput(input);

        return await this.#runTransaction(ctx, "register", async (txCtx) => {
            const id = normalizedInput.id ?? (await this.#newSecretId(txCtx, actingAgentId));
            const registration = this.#normalizeRegistration({ ...normalizedInput, id });
            const eventId = await this.#newEventId(txCtx, actingAgentId);
            const at = this.#now();
            const before = await this.#reference(txCtx, actingAgentId, registration.id);
            const raw = await this.#store.register(
                txCtx,
                actingAgentId,
                structuredClone(registration),
            );
            const mutation = this.#asRegisterResult(raw);
            const authoritative = await this.#requiredReference(
                txCtx,
                actingAgentId,
                registration.id,
                "register",
            );
            const changed = this.#reconcileRegister(mutation, registration, authoritative, before);
            return {
                result: authoritative,
                event: changed
                    ? this.#event(
                          {
                              type: "secret_registered",
                              secret: authoritative,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Update host-owned values or description and return safe metadata only. A repeated call overwrites. */
    async update(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
        input: SecretUpdateInput,
    ): Promise<SecretReference | undefined> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        this.#assertInput(secretUpdateInputSchema, input, "update");
        await this.#authorizeOperation(ctx, actingAgentId, "update");
        const normalizedInput = normalizeUpdateInput(input);

        return await this.#runTransaction(ctx, "update", async (txCtx) => {
            const eventId = await this.#newEventId(txCtx, actingAgentId);
            const at = this.#now();
            const before = await this.#reference(txCtx, actingAgentId, secretId);
            if (before === undefined) {
                const raw = await this.#store.update(
                    txCtx,
                    actingAgentId,
                    secretId,
                    structuredClone(normalizedInput),
                );
                const mutation = this.#asUpdateResult(raw, secretId);
                const after = await this.#reference(txCtx, actingAgentId, secretId);
                if (mutation.changed || mutation.reference !== undefined || after !== undefined) {
                    throw new Error("Secret update returned a mutation for a missing secret.");
                }
                return { result: undefined };
            }

            const raw = await this.#store.update(
                txCtx,
                actingAgentId,
                secretId,
                structuredClone(normalizedInput),
            );
            const mutation = this.#asUpdateResult(raw, secretId);
            const authoritative = await this.#requiredReference(
                txCtx,
                actingAgentId,
                secretId,
                "update",
            );
            const changed = this.#reconcileUpdate(
                mutation,
                before,
                authoritative,
                secretId,
                normalizedInput,
            );
            return {
                result: authoritative,
                event: changed
                    ? this.#event(
                          {
                              type: "secret_updated",
                              secret: authoritative,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Remove one secret and its attachments atomically in the module database. */
    async remove(ctx: Context, actingAgentId: string, secretId: string): Promise<boolean> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        await this.#authorizeOperation(ctx, actingAgentId, "remove");

        return await this.#runTransaction(ctx, "remove", async (txCtx) => {
            const eventId = await this.#newEventId(txCtx, actingAgentId);
            const at = this.#now();
            const before = await this.#reference(txCtx, actingAgentId, secretId);
            const raw = await this.#store.remove(txCtx, actingAgentId, secretId);
            const mutation = this.#asRemoveResult(raw, secretId);
            this.#reconcileRemove(mutation, before, secretId);
            const after = await this.#reference(txCtx, actingAgentId, secretId);
            if (before === undefined && after !== undefined) {
                throw new Error("Secret store remove created a missing secret.");
            }
            if (mutation.removed !== (before !== undefined && after === undefined)) {
                throw new Error("Secret store remove result is not authoritative.");
            }
            return {
                result: mutation.removed,
                event: mutation.removed
                    ? this.#event({ type: "secret_removed", secretId }, actingAgentId, eventId, at)
                    : undefined,
            };
        });
    }

    /** Attach one safe reference to an opaque host scope. */
    async attach(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
    ): Promise<SecretAttachment>;
    async attach(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
    ): Promise<SecretAttachment>;
    async attach(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId?: string,
    ): Promise<SecretAttachment> {
        const result = await this.#attachInternal(ctx, actingAgentId, scopeOrInput, secretId);
        return result.attachment;
    }

    /**
     * Attach one reference and retain the safe reference snapshot alongside the attachment. This is
     * what the durable tool calls so it can render both the attachment and the reference at once.
     */
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
    ): Promise<SecretAttachReferenceResult>;
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
    ): Promise<SecretAttachReferenceResult>;
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId?: string,
    ): Promise<SecretAttachReferenceResult> {
        return await this.#attachInternal(ctx, actingAgentId, scopeOrInput, secretId);
    }

    async #attachInternal(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId: string | undefined,
    ): Promise<SecretAttachReferenceResult> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        const input = this.#attachArguments(scopeOrInput, secretId);
        await this.#authorizeOperation(ctx, actingAgentId, "attach", input.scopeRef);

        return await this.#runTransaction(ctx, "attach", async (txCtx) => {
            const eventId = await this.#newEventId(txCtx, actingAgentId);
            const at = this.#now();
            const reference = await this.#reference(txCtx, actingAgentId, input.secretId);
            if (reference === undefined) {
                throw new Error("The secret reference does not exist.");
            }
            const before = await this.#attachment(txCtx, actingAgentId, input);
            const raw = await this.#store.attach(txCtx, actingAgentId, structuredClone(input));
            const mutation = this.#asAttachResult(raw, input);
            const authoritative = await this.#requiredAttachment(
                txCtx,
                actingAgentId,
                input,
                "attach",
            );
            this.#reconcileAttach(mutation, before, authoritative, input, reference);
            const toolResult: SecretAttachReferenceResult = {
                attachment: structuredClone(authoritative),
                secret: structuredClone(reference),
            };
            if (!Value.Check(secretAttachReferenceResultSchema, toolResult)) {
                throw new Error("Secrets module created an invalid attach result.");
            }
            return {
                result: toolResult,
                event: mutation.changed
                    ? this.#event(
                          {
                              type: "secret_attached",
                              attachment: authoritative,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Detach one safe reference from an opaque host scope. */
    async detach(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
    ): Promise<boolean>;
    async detach(ctx: Context, actingAgentId: string, input: SecretAttachInput): Promise<boolean>;
    async detach(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretId?: string,
    ): Promise<boolean> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        const input = this.#attachArguments(scopeOrInput, secretId);
        await this.#authorizeOperation(ctx, actingAgentId, "detach", input.scopeRef);

        return await this.#runTransaction(ctx, "detach", async (txCtx) => {
            const eventId = await this.#newEventId(txCtx, actingAgentId);
            const at = this.#now();
            const before = await this.#attachment(txCtx, actingAgentId, input);
            const raw = await this.#store.detach(txCtx, actingAgentId, structuredClone(input));
            const mutation = this.#asDetachResult(raw, input);
            const after = await this.#attachment(txCtx, actingAgentId, input);
            if (before === undefined && after !== undefined) {
                throw new Error("Secret store detach created a missing attachment.");
            }
            if (mutation.detached !== (before !== undefined && after === undefined)) {
                throw new Error("Secret store detach result is not authoritative.");
            }
            if (!mutation.detached && mutation.attachment !== undefined) {
                throw new Error("Secret store detach returned an attachment for a no-op.");
            }
            return {
                result: mutation.detached,
                event: mutation.detached
                    ? this.#event(
                          {
                              type: "secret_detached",
                              scopeRef: input.scopeRef,
                              secretId: input.secretId,
                          },
                          actingAgentId,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /**
     * Resolve attached values for a trusted host operation.
     *
     * This is deliberately not a tool and its result is never converted into model-facing text.
     */
    async resolveForHost(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretIds?: readonly string[],
    ): Promise<SecretHostEnvironment> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertScopeRef(scopeRef);
        await this.#authorizeOperation(ctx, actingAgentId, "resolve", scopeRef);
        if (
            secretIds !== undefined &&
            (!Array.isArray(secretIds) ||
                secretIds.length > MAX_SECRET_LIST_ITEMS ||
                new Set(secretIds).size !== secretIds.length ||
                secretIds.some((secretId) => !Value.Check(secretIdSchema, secretId)))
        ) {
            throw new Error("Secret resolver selection is invalid.");
        }
        const environment =
            this.#resolver === undefined
                ? await this.#store.resolveForHost(
                      ctx,
                      actingAgentId,
                      scopeRef,
                      secretIds === undefined ? undefined : structuredClone(secretIds),
                  )
                : await this.#resolver(
                      ctx,
                      actingAgentId,
                      scopeRef,
                      secretIds === undefined ? undefined : structuredClone(secretIds),
                  );
        assertSecretHostEnvironment(environment);
        return structuredClone(environment);
    }

    /** Common provider-neutral tools. None can call the raw host resolver. */
    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
        listSecretsTool(this, scope.agent.id),
        referenceSecretTool(this, scope.agent.id),
        attachSecretTool(this, scope.agent.id),
        detachSecretTool(this, scope.agent.id),
    ];

    /** Tell the model that metadata is available while values remain host-only. */
    readonly instructions = async (): Promise<string> =>
        "Secret tools expose references and environment-variable names only. Secret values are available only to the host and must never be requested in chat, tool arguments, or model output.";

    /** Render safe metadata for a model without ever reading host values. */
    formatForModel(page: SecretPage): string {
        const normalized = this.#normalizePage(page);
        const output = this.#formatPage(normalized, false);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret model output cannot fit complete metadata identities.");
        }
        return output;
    }

    /** Render a page and retain its opaque continuation cursor for the model. */
    formatPageForModel(page: SecretPage): string {
        const normalized = this.#normalizePage(page);
        const output = this.#formatPage(normalized, true);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret page output cannot fit complete metadata and cursor.");
        }
        return output;
    }

    /** Format an attachment result without allowing tool-added context to exceed the cap. */
    formatAttachmentForModel(scopeRef: SecretScopeRef, secret: SecretReference): string {
        this.#assertScopeRef(scopeRef);
        const normalized = this.#normalizeReference(secret);
        const detailed = `Attached ${JSON.stringify(normalized.id)} to scope ${JSON.stringify(scopeRef)}.\n${this.#formatPage(
            {
                secrets: [normalized],
                limit: 1,
            },
            false,
        )}`;
        const output =
            detailed.length <= this.#maxOutputCharacters
                ? detailed
                : `attach\nscope=${scopeRef}\nsecret=${normalized.id}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret attachment output cannot fit complete metadata.");
        }
        return output;
    }

    /** Format a detach result without allowing long opaque identities to bypass the cap. */
    formatDetachForModel(detached: boolean, scopeRef: SecretScopeRef, secretId: SecretId): string {
        this.#assertScopeRef(scopeRef);
        this.#assertSecretId(secretId);
        const detailed = detached
            ? `Detached ${JSON.stringify(secretId)} from scope ${JSON.stringify(scopeRef)}.`
            : `Secret ${JSON.stringify(secretId)} was not attached to scope ${JSON.stringify(scopeRef)}.`;
        const output =
            detailed.length <= this.#maxOutputCharacters
                ? detailed
                : detached
                  ? `detached\nscope=${scopeRef}\nsecret=${secretId}`
                  : `not attached\nscope=${scopeRef}\nsecret=${secretId}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret detach output cannot fit complete identities.");
        }
        return output;
    }

    async #readPage(
        ctx: Context,
        actingAgentId: SecretAgentId,
        query: SecretListQuery,
    ): Promise<SecretPage> {
        const raw = await this.#store.list(ctx, actingAgentId, query);
        assertSecretPage(raw);
        if (raw.limit !== query.limit || raw.secrets.length > query.limit) {
            throw new Error("Secret store returned a page outside the requested bounds.");
        }
        if (raw.nextCursor !== undefined) {
            if (
                raw.secrets.length === 0 ||
                !cursorProgressed(query.cursor, raw.nextCursor, raw.secrets.length)
            ) {
                throw new Error("Secret store returned a non-progressing secret cursor.");
            }
        }
        const page = this.#normalizePage({
            secrets: raw.secrets,
            limit: query.limit,
            ...(raw.nextCursor === undefined ? {} : { nextCursor: raw.nextCursor }),
        });
        if (query.scopeRef !== undefined) {
            for (const secret of page.secrets) {
                const attachment = await this.#attachment(ctx, actingAgentId, {
                    scopeRef: query.scopeRef,
                    secretId: secret.id,
                });
                if (attachment === undefined) {
                    throw new Error(
                        "Secret store returned a reference that is not attached to the requested scope.",
                    );
                }
            }
        }
        return page;
    }

    #formatPage(page: SecretPage, includeCursor: boolean): string {
        const withCursor = (rows: string): string =>
            includeCursor && page.nextCursor !== undefined
                ? `${rows}\nnext=${page.nextCursor}`
                : rows;
        const detailedRows =
            page.secrets.length === 0
                ? "No secret references."
                : page.secrets.map((secret) => this.#formatReference(secret)).join("\n");
        const detailed = withCursor(detailedRows);
        if (detailed.length <= this.#maxOutputCharacters) return detailed;
        const compactRows =
            page.secrets.length === 0
                ? "No secret references."
                : page.secrets.map((secret) => `secret id=${secret.id}`).join("\n");
        return withCursor(compactRows);
    }

    async #runTransaction<Result>(
        ctx: Context,
        _operation: string,
        work: (txCtx: Context) => Promise<SecretChange<Result>>,
    ): Promise<Result> {
        return await ctx.inTx(async (txCtx) => {
            const change = await work(txCtx);
            if (change.event !== undefined) {
                await this.#observe(txCtx, change.event);
            }
            return structuredClone(change.result);
        });
    }

    async #observe(ctx: Context, event: SecretEvent): Promise<void> {
        if (!Value.Check(secretEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Secrets module created an invalid unfrozen event.");
        }
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await transactional.call(this.#listener, ctx, event);
        }
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: SecretEvent): Promise<void> {
        try {
            const listener = this.#listener?.onEvent;
            if (listener !== undefined) {
                await listener.call(this.#listener, ctx, event);
            }
        } catch (error: unknown) {
            try {
                await this.#onPostCommitError?.(ctx, event, error);
            } catch {
                // Reporting is advisory after durable state has settled.
            }
        }
    }

    #asRegisterResult(value: unknown): SecretStoreRegisterResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "register") {
            throw new Error("Secret store register returned the wrong operation.");
        }
        return value;
    }

    #asUpdateResult(value: unknown, secretId: SecretId): SecretStoreUpdateResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "update" || value.secretId !== secretId) {
            throw new Error("Secret store update returned a different secret identity.");
        }
        return value;
    }

    #asRemoveResult(value: unknown, secretId: SecretId): SecretStoreRemoveResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "remove" || value.secretId !== secretId) {
            throw new Error("Secret store remove returned a different secret identity.");
        }
        return value;
    }

    #asAttachResult(value: unknown, input: SecretAttachInput): SecretStoreAttachResult {
        assertSecretStoreMutationResult(value);
        if (
            value.operation !== "attach" ||
            value.attachment.scopeRef !== input.scopeRef ||
            value.attachment.secretId !== input.secretId
        ) {
            throw new Error("Secret store attach returned a different attachment.");
        }
        return value;
    }

    #asDetachResult(value: unknown, input: SecretAttachInput): SecretStoreDetachResult {
        assertSecretStoreMutationResult(value);
        if (value.operation !== "detach") {
            throw new Error("Secret store detach returned the wrong operation.");
        }
        if (
            value.attachment !== undefined &&
            (value.attachment.scopeRef !== input.scopeRef ||
                value.attachment.secretId !== input.secretId)
        ) {
            throw new Error("Secret store detach returned a different attachment.");
        }
        return value;
    }

    #reconcileRegister(
        mutation: SecretStoreRegisterResult,
        request: SecretRegistration,
        authoritative: SecretReference,
        before: SecretReference | undefined,
    ): boolean {
        if (mutation.reference.id !== request.id || authoritative.id !== request.id) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        if (
            authoritative.description !== request.description ||
            !sameEnvironmentNames(authoritative.environmentVariables, request.environment)
        ) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        const mutationReference = this.#normalizeReference(mutation.reference);
        const changed = before === undefined || !sameReference(before, authoritative);
        if (mutation.changed !== changed || !sameReference(mutationReference, authoritative)) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        return changed;
    }

    #reconcileUpdate(
        mutation: SecretStoreUpdateResult,
        before: SecretReference,
        authoritative: SecretReference,
        secretId: SecretId,
        request: SecretUpdateInput,
    ): boolean {
        const expectedDescription = request.description ?? before.description;
        const expectedEnvironmentNames = applyEnvironmentPatch(
            before.environmentVariables,
            request.environment,
        );
        if (
            authoritative.description !== expectedDescription ||
            !sameStrings(authoritative.environmentVariables, expectedEnvironmentNames)
        ) {
            throw new Error("Secret store did not authoritatively persist the update.");
        }
        const mutationReference =
            mutation.reference === undefined
                ? undefined
                : this.#normalizeReference(mutation.reference);
        const changed = !sameReference(before, authoritative);
        if (
            mutationReference === undefined ||
            mutationReference.id !== secretId ||
            !sameReference(mutationReference, authoritative) ||
            mutation.changed !== changed
        ) {
            throw new Error("Secret store did not authoritatively persist the update.");
        }
        return changed;
    }

    #reconcileRemove(
        mutation: SecretStoreRemoveResult,
        before: SecretReference | undefined,
        secretId: SecretId,
    ): void {
        if (
            mutation.secretId !== secretId ||
            mutation.removed !== (before !== undefined) ||
            (mutation.reference !== undefined &&
                (before === undefined || !sameReference(mutation.reference, before)))
        ) {
            throw new Error("Secret store remove result is not authoritative.");
        }
    }

    #reconcileAttach(
        mutation: SecretStoreAttachResult,
        before: SecretAttachment | undefined,
        authoritative: SecretAttachment,
        input: SecretAttachInput,
        reference: SecretReference,
    ): void {
        if (
            mutation.attachment.scopeRef !== input.scopeRef ||
            mutation.attachment.secretId !== input.secretId ||
            !sameJson(mutation.attachment, authoritative) ||
            mutation.changed !== (before === undefined) ||
            (mutation.reference !== undefined &&
                !sameReference(this.#normalizeReference(mutation.reference), reference))
        ) {
            throw new Error("Secret store did not authoritatively persist the attachment.");
        }
    }

    async #requiredReference(
        ctx: Context,
        actingAgentId: SecretAgentId,
        secretId: SecretId,
        operation: string,
    ): Promise<SecretReference> {
        const current = await this.#reference(ctx, actingAgentId, secretId);
        if (current === undefined) {
            throw new Error(`Secret store ${operation} has no authoritative reference.`);
        }
        return current;
    }

    async #reference(
        ctx: Context,
        actingAgentId: SecretAgentId,
        secretId: SecretId,
    ): Promise<SecretReference | undefined> {
        const value = await this.#store.reference(ctx, actingAgentId, secretId);
        if (value === undefined) return undefined;
        const reference = this.#normalizeReference(value);
        if (reference.id !== secretId) {
            throw new Error("Secret store returned a different reference identity.");
        }
        return reference;
    }

    async #attachment(
        ctx: Context,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
    ): Promise<SecretAttachment | undefined> {
        const value = await this.#store.attachment(ctx, actingAgentId, input);
        if (value === undefined) return undefined;
        assertSecretAttachment(value);
        if (value.scopeRef !== input.scopeRef || value.secretId !== input.secretId) {
            throw new Error("Secret store returned a different attachment identity.");
        }
        return structuredClone(value);
    }

    async #requiredAttachment(
        ctx: Context,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
        operation: string,
    ): Promise<SecretAttachment> {
        const value = await this.#attachment(ctx, actingAgentId, input);
        if (value === undefined) {
            throw new Error(`Secret store ${operation} has no authoritative attachment.`);
        }
        return value;
    }

    async #authorizeOperation(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: Static<typeof secretAuthorizationOperationSchema>,
        scopeRef?: SecretScopeRef,
    ): Promise<void> {
        if (this.#authorize === undefined) return;
        const allowed = await this.#authorize(ctx, actingAgentId, operation, scopeRef);
        if (typeof allowed !== "boolean") {
            throw new Error("Secret authorization returned an invalid result.");
        }
        if (!allowed) throw new Error("The acting agent is not authorized for this secret scope.");
    }

    async #newSecretId(ctx: Context, actingAgentId: SecretAgentId): Promise<SecretId> {
        const value = await this.#idFactory(ctx, actingAgentId);
        if (!Value.Check(secretIdSchema, value)) {
            throw new Error("Secret id factory returned an invalid identity.");
        }
        return value;
    }

    async #newEventId(ctx: Context, actingAgentId: SecretAgentId): Promise<string> {
        const value = await this.#eventIdFactory(ctx, actingAgentId);
        if (!Value.Check(secretEventIdSchema, value)) {
            throw new Error("Secret event ID factory returned an invalid ID.");
        }
        return value;
    }

    #event(
        payload:
            | {
                  readonly type: "secret_registered" | "secret_updated";
                  readonly secret: SecretReference;
              }
            | { readonly type: "secret_removed"; readonly secretId: SecretId }
            | {
                  readonly type: "secret_attached";
                  readonly attachment: SecretAttachment;
              }
            | {
                  readonly type: "secret_detached";
                  readonly scopeRef: SecretScopeRef;
                  readonly secretId: SecretId;
              },
        actingAgentId: SecretAgentId,
        eventId: string,
        at: number,
    ): SecretEvent {
        const event = {
            ...payload,
            eventId,
            at,
            agentId: actingAgentId,
        };
        if (!Value.Check(secretEventSchema, event)) {
            throw new Error("Secrets module created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    #normalizeRegistration(
        input: SecretRegistrationInput & { readonly id: SecretId },
    ): SecretRegistration {
        const registration = {
            id: input.id,
            description: normalizeText(input.description),
            environment: normalizeEnvironment(input.environment),
        };
        if (!Value.Check(secretRegistrationSchema, registration)) {
            throw new Error("Secret registration is invalid.");
        }
        return registration;
    }

    #normalizePage(value: SecretPage): SecretPage {
        assertSecretPage(value);
        if (value.limit > this.#maxPageSize || value.secrets.length > value.limit) {
            throw new Error("Secret page exceeds the configured metadata bound.");
        }
        const ids = new Set<string>();
        const secrets = value.secrets.map((secret) => {
            const normalized = this.#normalizeReference(secret);
            if (ids.has(normalized.id)) throw new Error("Secret page contains duplicate IDs.");
            ids.add(normalized.id);
            return normalized;
        });
        return {
            secrets,
            limit: value.limit,
            ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
        };
    }

    #normalizeReference(value: SecretReference): SecretReference {
        assertSecretReference(value);
        const names = [...value.environmentVariables];
        const normalizedNames = new Set<string>();
        for (const name of names) {
            const normalized = name.toUpperCase();
            if (normalizedNames.has(normalized)) {
                throw new Error("Secret metadata contains duplicate environment variable names.");
            }
            normalizedNames.add(normalized);
        }
        return {
            id: value.id,
            description: value.description,
            environmentVariables: names.sort((left, right) => left.localeCompare(right)),
            revision: value.revision,
            ...(value.availableToModel === undefined
                ? {}
                : { availableToModel: value.availableToModel }),
            ...(value.kind === undefined ? {} : { kind: value.kind }),
        };
    }

    #formatReference(secret: SecretReference): string {
        return [
            `${JSON.stringify(secret.id)}: ${secret.description}`,
            `  Environment variables: ${
                secret.environmentVariables.length === 0
                    ? "none"
                    : secret.environmentVariables.join(", ")
            }`,
            `  Revision: ${JSON.stringify(secret.revision)}`,
            ...(secret.availableToModel === false ? ["  Availability: host only"] : []),
        ].join("\n");
    }

    #listQuery(query: SecretListInput): SecretListQuery {
        const normalized = {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.scopeRef === undefined ? {} : { scopeRef: query.scopeRef }),
            limit: query.limit ?? this.#maxPageSize,
        };
        if (!Value.Check(secretListQuerySchema, normalized)) {
            throw new Error("Secret list query is invalid.");
        }
        if (normalized.limit > this.#maxPageSize) {
            throw new Error(`Secret page limit cannot exceed ${this.#maxPageSize}.`);
        }
        return normalized;
    }

    #attachArguments(
        scopeOrInput: string | SecretAttachInput,
        secretId: string | undefined,
    ): SecretAttachInput {
        if (typeof scopeOrInput === "string") {
            if (typeof secretId !== "string") {
                throw new Error("Secret attachment input is invalid.");
            }
            const input = { scopeRef: scopeOrInput, secretId };
            if (!Value.Check(secretAttachInputSchema, input)) {
                throw new Error("Secret attachment input is invalid.");
            }
            return input;
        }
        if (!Value.Check(secretAttachInputSchema, scopeOrInput)) {
            throw new Error("Secret attachment input is invalid.");
        }
        return { scopeRef: scopeOrInput.scopeRef, secretId: scopeOrInput.secretId };
    }

    #assertContext(value: unknown): asserts value is Context {
        if (!Value.Check(secretContextSchema, value)) {
            throw new Error("Secret context is invalid.");
        }
    }

    #assertAgentId(value: unknown): asserts value is SecretAgentId {
        if (!Value.Check(secretAgentIdSchema, value)) {
            throw new Error("Secret acting agent ID is invalid.");
        }
    }

    #assertSecretId(value: unknown): asserts value is SecretId {
        if (!Value.Check(secretIdSchema, value)) {
            throw new Error("Secret ID is invalid.");
        }
    }

    #assertScopeRef(value: unknown): asserts value is SecretScopeRef {
        if (!Value.Check(secretScopeRefSchema, value)) {
            throw new Error("Secret scope reference is invalid.");
        }
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) {
            throw new Error(`Secret ${label} input is invalid.`);
        }
    }

    #now(): number {
        const at = this.#clock();
        if (!Value.Check(secretEventTimestampSchema, at)) {
            throw new Error("Secret clock must return a non-negative integer timestamp.");
        }
        return at;
    }
}

/** Validate every configured callable and reject unknown option keys. */
export function assertSecretsModuleOptions(value: unknown): asserts value is SecretsModuleOptions {
    if (!Value.Check(secretModuleOptionsSchema, value)) {
        throw new Error(
            "Secrets module options are invalid; check the resolver, listener, and callbacks.",
        );
    }
}

function normalizeRegistrationInput(input: SecretRegistrationInput): SecretRegistrationInput {
    const normalized = {
        ...(input.id === undefined ? {} : { id: input.id }),
        description: normalizeText(input.description),
        environment: normalizeEnvironment(input.environment),
    };
    if (!Value.Check(secretRegistrationInputSchema, normalized)) {
        throw new Error("Secret registration input is invalid after normalization.");
    }
    return normalized;
}

function normalizeUpdateInput(input: SecretUpdateInput): SecretUpdateInput {
    const normalized = {
        ...(input.description === undefined
            ? {}
            : { description: normalizeText(input.description) }),
        ...(input.environment === undefined
            ? {}
            : { environment: normalizeEnvironmentPatch(input.environment) }),
    };
    if (!Value.Check(secretUpdateInputSchema, normalized)) {
        throw new Error("Secret update input is invalid after normalization.");
    }
    return normalized;
}

function normalizeEnvironment(
    environment: SecretRegistration["environment"],
): SecretRegistration["environment"] {
    const result = Object.create(null) as Record<string, string>;
    const names = new Set<string>();
    for (const [name, value] of Object.entries(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secret registration contains duplicate environment variable names.");
        }
        names.add(normalized);
        Object.defineProperty(result, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return result;
}

function normalizeEnvironmentPatch(
    environment: NonNullable<SecretUpdateInput["environment"]>,
): NonNullable<SecretUpdateInput["environment"]> {
    const result = Object.create(null) as Record<string, string | null>;
    const names = new Set<string>();
    for (const [name, value] of Object.entries(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secret update contains duplicate environment variable names.");
        }
        names.add(normalized);
        Object.defineProperty(result, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return result;
}

function normalizeText(value: string): string {
    const normalized = value.trim();
    if (!Value.Check(Type.String({ minLength: 1, maxLength: 2_000 }), normalized)) {
        throw new Error("Secret description is invalid after normalization.");
    }
    return normalized;
}

function sameReference(left: SecretReference, right: SecretReference): boolean {
    return (
        left.id === right.id &&
        left.description === right.description &&
        sameStrings(left.environmentVariables, right.environmentVariables) &&
        left.revision === right.revision &&
        left.availableToModel === right.availableToModel &&
        left.kind === right.kind
    );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameEnvironmentNames(
    referenceNames: readonly string[],
    environment: Record<string, string>,
): boolean {
    return sameStrings(referenceNames, sortEnvironmentNames(Object.keys(environment)));
}

function applyEnvironmentPatch(
    before: readonly string[],
    patch: SecretUpdateInput["environment"],
): readonly string[] {
    const names = new Set(before);
    if (patch !== undefined) {
        for (const [name, value] of Object.entries(patch)) {
            if (value === null) names.delete(name);
            else names.add(name);
        }
    }
    return sortEnvironmentNames([...names]);
}

function sortEnvironmentNames(names: readonly string[]): string[] {
    return [...names].sort((left, right) => left.localeCompare(right));
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonicalize(left, 0)) === JSON.stringify(canonicalize(right, 0));
}

function canonicalize(value: unknown, depth: number): unknown {
    if (depth > 32) {
        throw new Error("Secret structured comparison exceeds its nesting depth bound.");
    }
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item, depth + 1));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonicalize(item, depth + 1)]),
        );
    }
    return value;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function isDeepFrozen(value: unknown): boolean {
    if (value !== null && typeof value === "object") {
        if (!Object.isFrozen(value)) return false;
        return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
    }
    return true;
}

function cursorProgressed(
    requested: number | undefined,
    next: number,
    visibleCount: number,
): boolean {
    const current = requested ?? 0;
    const expected = current + visibleCount;
    return Number.isSafeInteger(expected) && next === expected;
}
