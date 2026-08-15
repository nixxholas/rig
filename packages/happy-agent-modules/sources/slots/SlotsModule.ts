import {
    type AgentModule,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    allowedSlotScopes,
    MAX_SLOT_ENTRIES,
    MAX_SLOT_OUTPUT_CHARACTERS,
    MAX_SLOT_PAGE_SIZE,
    scopeReferenceFromEntry,
    slotAgentIdSchema,
    slotContentSchema,
    slotCreateInputSchema,
    slotDescriptionSchema,
    slotEntrySchema,
    slotIdSchema,
    slotPurposeSchema,
    slotReorderInputSchema,
    slotTimestampSchema,
    slotUpdateInputSchema,
    type SlotContent,
    type SlotCreateInput,
    type SlotEntry,
    type SlotName,
    type SlotReorderInput,
    type SlotScopeReference,
    type SlotUpdateInput,
} from "./Slot.js";
import { createSlotDatabase, slotsMigrations, type SlotDatabase } from "./SlotDatabase.js";
import {
    MAX_SLOT_DETAIL_PAGE_SIZE,
    slotDetailCursorSchema,
    slotDetailPageSchema,
    slotDetailQuerySchema,
    type SlotDetailPage,
    type SlotDetailQuery,
} from "./SlotDetailPage.js";
import {
    slotEventIdSchema,
    slotEventSchema,
    slotListenerValidationView,
    slotModuleListenerSchema,
    type SlotEvent,
    type SlotModuleListener,
} from "./SlotEvent.js";
import {
    slotPageQuerySchema,
    slotPageSchema,
    type SlotPage,
    type SlotPageQuery,
} from "./SlotPage.js";
import {
    assertSlotStoreEntry,
    assertSlotStorePage,
    slotPublisherSchema,
    slotReadAuthorizationSchema,
    slotScopeResolverSchema,
    type SlotReadAuthorization,
    type SlotReadOperation,
    type SlotStoreCreateInput,
} from "./SlotStore.js";
import { createSlotTool } from "./tools/create_slot.js";
import { getSlotTool } from "./tools/get_slot.js";
import { listSlotsTool } from "./tools/list_slots.js";
import { removeSlotTool } from "./tools/remove_slot.js";
import { reorderSlotsTool } from "./tools/reorder_slots.js";
import { updateSlotTool } from "./tools/update_slot.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 12_000;
const REORDER_RESULT_PREFIX = "Slot entries reordered.\n";

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const idFactorySchema = Type.Unsafe<(ctx: Context, agentId: string) => string | Promise<string>>(
    Type.Function(
        [opaqueContextSchema, slotAgentIdSchema],
        Type.Union([slotIdSchema, Type.Promise(slotIdSchema)]),
    ),
);
const eventIdFactorySchema = Type.Unsafe<
    (ctx: Context, agentId: string) => string | Promise<string>
>(
    Type.Function(
        [opaqueContextSchema, slotAgentIdSchema],
        Type.Union([slotEventIdSchema, Type.Promise(slotEventIdSchema)]),
    ),
);
const clockSchema = Type.Unsafe<() => number>(Type.Function([], slotTimestampSchema));
const postCommitErrorHandlerSchema = Type.Unsafe<
    (ctx: Context, event: SlotEvent, error: unknown) => void | Promise<void>
>(
    Type.Function(
        [opaqueContextSchema, slotEventSchema, Type.Unknown()],
        Type.Union([Type.Void(), Type.Promise(Type.Unknown())]),
    ),
);

export const slotModuleOptionsSchema = Type.Object(
    {
        scopeResolver: slotScopeResolverSchema,
        publisher: slotPublisherSchema,
        readAuthorization: Type.Optional(slotReadAuthorizationSchema),
        idFactory: Type.Optional(idFactorySchema),
        eventIdFactory: Type.Optional(eventIdFactorySchema),
        clock: Type.Optional(clockSchema),
        listener: Type.Optional(slotModuleListenerSchema),
        maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLOT_ENTRIES })),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLOT_PAGE_SIZE })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: MAX_SLOT_OUTPUT_CHARACTERS }),
        ),
        onPostCommitError: Type.Optional(postCommitErrorHandlerSchema),
    },
    { additionalProperties: false },
);

export type SlotsModuleOptions = Static<typeof slotModuleOptionsSchema>;

/** Persistent UI slots with atomic mutation and durable tool completion. */
export class SlotsModule implements AgentModule {
    readonly name = "slots";
    readonly migrations = slotsMigrations;

    readonly #store: SlotDatabase;
    readonly #scopeResolver: Static<typeof slotScopeResolverSchema>;
    readonly #publisher: Static<typeof slotPublisherSchema>;
    readonly #readAuthorization: SlotReadAuthorization | undefined;
    readonly #idFactory: NonNullable<SlotsModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<SlotsModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<SlotsModuleOptions["clock"]>;
    readonly #listener: SlotModuleListener | undefined;
    readonly #maxEntries: number;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: SlotsModuleOptions["onPostCommitError"];

    constructor(options: SlotsModuleOptions) {
        assertSlotsModuleOptions(options);
        this.#store = createSlotDatabase();
        this.#scopeResolver = options.scopeResolver;
        this.#publisher = options.publisher;
        this.#readAuthorization = options.readAuthorization;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#maxEntries = options.maxEntries ?? MAX_SLOT_ENTRIES;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        this.#onPostCommitError = options.onPostCommitError;
    }

    async listPage(ctx: Context, agentId: string, query: SlotPageQuery = {}): Promise<SlotPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(slotPageQuerySchema, query, "page query");
        const normalized = this.#normalizePageQuery(query);
        return await ctx.inTx(async (txCtx) => {
            for (let limit = normalized.limit; limit >= 1; limit -= 1) {
                const page = await this.#readPage(txCtx, agentId, { ...normalized, limit });
                await this.#authorizeEntries(txCtx, agentId, page.entries, "list");
                await this.#validateScopeReferences(txCtx, agentId, page.entries);
                if (
                    this.#formatPage(page, this.#maxOutputCharacters).length <=
                    this.#maxOutputCharacters
                ) {
                    return page;
                }
            }
            throw new Error("Slot list output cannot fit a complete entry identity and cursor.");
        });
    }

    async list(
        ctx: Context,
        agentId: string,
        query: SlotPageQuery = {},
    ): Promise<readonly SlotEntry[]> {
        return (await this.listPage(ctx, agentId, query)).entries;
    }

    async get(ctx: Context, agentId: string, id: string): Promise<SlotEntry | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        return await ctx.inTx(async (txCtx) => {
            const entry = await this.#readOptional(txCtx, agentId, id);
            if (entry === undefined) return undefined;
            await this.#authorizeRead(txCtx, agentId, entry.authorAgentId, "get");
            await this.#assertScope(txCtx, agentId, entry.slot, entry);
            return structuredClone(entry);
        });
    }

    async getPage(
        ctx: Context,
        agentId: string,
        id: string,
        query: SlotDetailQuery = {},
    ): Promise<SlotDetailPage> {
        this.#assertInput(slotDetailQuerySchema, query, "detail query");
        const entry = await this.get(ctx, agentId, id);
        if (entry === undefined) return { entry: null };
        const detail = slotDetailText(entry);
        if (!Value.Check(slotDetailCursorSchema, detail.length)) {
            throw new Error("Slot detail exceeds its bounded traversal length.");
        }
        const detailOffset = query.detailOffset ?? 0;
        const detailLimit = query.detailLimit ?? MAX_SLOT_DETAIL_PAGE_SIZE;
        return this.#fitDetailPage({
            entry,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
        });
    }

    async create(ctx: Context, agentId: string, input: SlotCreateInput): Promise<SlotEntry> {
        return await this.#create(ctx, agentId, input);
    }

    async #create(
        ctx: Context,
        agentId: string,
        input: SlotCreateInput,
    ): Promise<SlotEntry> {
        this.#assertAgentId(agentId);
        this.#assertInput(slotCreateInputSchema, input, "creation");
        return await ctx.inTx(async (txCtx) => {
            const id = input.id ?? (await this.#newId(txCtx, agentId));
            this.#assertId(id);
            const normalized = normalizeCreateInput({ ...input, id });
            const request = withCreateIdentity(normalized, id, agentId);
            const before = await this.#readAll(txCtx, agentId);
            if (before.some((entry) => entry.id === id)) {
                throw new Error(`Slot entry "${id}" already exists.`);
            }
            if (before.length >= this.#maxEntries) {
                throw new Error(
                    `The slot catalog already has the maximum of ${this.#maxEntries} entries.`,
                );
            }
            await this.#assertScope(txCtx, agentId, request.slot, request);
            const created = await this.#store.create(txCtx, agentId, request);
            this.#validateEntry(created);
            if (!sameCreation(created, request) || created.ordering !== before.length) {
                throw new Error("Slots database created a different entry.");
            }
            const event = await this.#event(txCtx, {
                type: "slot_entry_created",
                agentId,
                entry: created,
            });
            await this.#observe(txCtx, event);
            return structuredClone(created);
        });
    }

    async update(
        ctx: Context,
        agentId: string,
        id: string,
        changes: SlotUpdateInput,
    ): Promise<SlotEntry> {
        return await this.#update(ctx, agentId, id, changes);
    }

    async #update(
        ctx: Context,
        agentId: string,
        id: string,
        changes: SlotUpdateInput,
    ): Promise<SlotEntry> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        this.#assertInput(slotUpdateInputSchema, changes, "update");
        const normalized = normalizeUpdateInput(changes);
        return await ctx.inTx(async (txCtx) => {
            const existing = await this.#readRequired(txCtx, agentId, id);
            this.#assertOwner(agentId, existing);
            const candidate = { ...existing, ...normalized };
            this.#validateEntry(candidate);
            await this.#assertScope(txCtx, agentId, candidate.slot, candidate);
            if (sameMutable(existing, candidate)) {
                return structuredClone(existing);
            }
            const updated = await this.#store.update(txCtx, agentId, id, normalized);
            this.#validateEntry(updated);
            if (!sameUpdate(existing, updated, normalized)) {
                throw new Error("Slots database updated immutable or unrequested entry fields.");
            }
            const event = await this.#event(txCtx, {
                type: "slot_entry_updated",
                agentId,
                entry: updated,
                changes: normalized,
            });
            await this.#observe(txCtx, event);
            return structuredClone(updated);
        });
    }

    async reorder(
        ctx: Context,
        agentId: string,
        entryIds: SlotReorderInput,
    ): Promise<readonly SlotEntry[]> {
        return await this.#reorder(ctx, agentId, entryIds);
    }

    async reorderPage(
        ctx: Context,
        agentId: string,
        entryIds: SlotReorderInput,
    ): Promise<SlotPage> {
        return await ctx.inTx(async (txCtx) =>
            this.#fitReorderPage(await this.#reorder(txCtx, agentId, entryIds)),
        );
    }

    async #reorder(
        ctx: Context,
        agentId: string,
        entryIds: SlotReorderInput,
    ): Promise<readonly SlotEntry[]> {
        this.#assertAgentId(agentId);
        this.#assertInput(slotReorderInputSchema, entryIds, "reorder");
        const ids = [...entryIds];
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#readAll(txCtx, agentId);
            this.#assertCompleteOrder(before, ids);
            before.forEach((entry) => this.#assertOwner(agentId, entry));
            const beforeIds = before.map((entry) => entry.id);
            if (sameIds(beforeIds, ids)) {
                return before.map((entry) => structuredClone(entry));
            }
            const reordered = await this.#store.reorder(txCtx, agentId, ids);
            this.#validateEntries(reordered);
            if (
                !sameIds(
                    reordered.map((entry) => entry.id),
                    ids,
                )
            ) {
                throw new Error("Slots database returned a different reordered catalog.");
            }
            const beforeById = new Map(before.map((entry) => [entry.id, entry]));
            if (
                reordered.some((entry) => {
                    const previous = beforeById.get(entry.id);
                    return previous === undefined || !sameReorderStableFields(previous, entry);
                })
            ) {
                throw new Error("Slots database changed entry content while reordering.");
            }
            const event = await this.#event(txCtx, {
                type: "slot_entries_reordered",
                agentId,
                entryIds: ids,
                entries: reordered,
            });
            await this.#observe(txCtx, event);
            return reordered.map((entry) => structuredClone(entry));
        });
    }

    async remove(ctx: Context, agentId: string, id: string): Promise<boolean> {
        return await this.#remove(ctx, agentId, id);
    }

    async #remove(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<boolean> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        return await ctx.inTx(async (txCtx) => {
            const existing = await this.#readOptional(txCtx, agentId, id);
            if (existing === undefined) return false;
            this.#assertOwner(agentId, existing);
            const removed = await this.#store.remove(txCtx, agentId, id);
            if (removed === undefined || !sameJson(removed, existing)) {
                throw new Error("Slots database removed a different entry.");
            }
            const event = await this.#event(txCtx, {
                type: "slot_entry_removed",
                agentId,
                entry: existing,
                entryId: id,
            });
            await this.#observe(txCtx, event);
            return true;
        });
    }

    readonly tools = (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
        createSlotTool(this, scope.agent.id),
        listSlotsTool(this, scope.agent.id),
        getSlotTool(this, scope.agent.id),
        updateSlotTool(this, scope.agent.id),
        reorderSlotsTool(this, scope.agent.id),
        removeSlotTool(this, scope.agent.id),
    ];

    formatForModel(entries: readonly SlotEntry[]): string {
        return this.#formatEntries(entries, this.#maxOutputCharacters);
    }

    formatOperationForModel(label: string, entry: SlotEntry): string {
        const prefix = `${label}\n`;
        return `${prefix}${this.#formatEntries([entry], this.#maxOutputCharacters - prefix.length)}`;
    }

    formatDetailPageForModel(page: SlotDetailPage): string {
        if (!Value.Check(slotDetailPageSchema, page)) {
            throw new Error("Cannot format an invalid slot detail page.");
        }
        if (page.entry === null) return "That slot entry does not exist.";
        return formatSlotDetailPage(page, this.#maxOutputCharacters);
    }

    formatPageForModel(page: SlotPage): string {
        if (!Value.Check(slotPageSchema, page)) {
            throw new Error("Cannot format an invalid slot page.");
        }
        return this.#formatPage(page, this.#maxOutputCharacters);
    }

    formatReorderPageForModel(page: SlotPage): string {
        const body = this.#formatPage(
            page,
            this.#maxOutputCharacters - REORDER_RESULT_PREFIX.length,
        );
        return `${REORDER_RESULT_PREFIX}${body}`;
    }

    async #readPage(
        ctx: Context,
        agentId: string,
        query: SlotPageQuery & { readonly limit: number },
    ): Promise<SlotPage> {
        const page = await this.#store.list(ctx, agentId, query);
        assertSlotStorePage(page);
        if (page.limit !== query.limit || page.entries.length > query.limit) {
            throw new Error("Slots database returned a page outside the requested bounds.");
        }
        if (
            page.nextCursor !== undefined &&
            (page.entries.length === 0 ||
                page.nextCursor !== (query.cursor ?? 0) + page.entries.length)
        ) {
            throw new Error("Slots database returned a non-progressing cursor.");
        }
        this.#validatePageEntries(page.entries, query);
        return structuredClone(page);
    }

    async #readAll(ctx: Context, agentId: string): Promise<readonly SlotEntry[]> {
        const entries: SlotEntry[] = [];
        let cursor: number | undefined;
        const seen = new Set<number>();
        for (;;) {
            const page = await this.#readPage(ctx, agentId, {
                ...(cursor === undefined ? {} : { cursor }),
                limit: Math.min(this.#maxEntries, this.#maxPageSize),
            });
            entries.push(...page.entries);
            if (entries.length > this.#maxEntries) {
                throw new Error("Slot catalog exceeds its configured bound.");
            }
            if (page.nextCursor === undefined) break;
            if (seen.has(page.nextCursor)) {
                throw new Error("Slots database returned a repeating cursor.");
            }
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
        }
        this.#validateEntries(entries);
        return [...entries].sort(compareEntries);
    }

    async #readOptional(ctx: Context, agentId: string, id: string): Promise<SlotEntry | undefined> {
        const entry = await this.#store.get(ctx, agentId, id);
        if (entry === undefined) return undefined;
        assertSlotStoreEntry(entry);
        this.#validateEntry(entry);
        if (entry.id !== id) throw new Error("Slots database returned a different entry.");
        return structuredClone(entry);
    }

    async #readRequired(ctx: Context, agentId: string, id: string): Promise<SlotEntry> {
        const entry = await this.#readOptional(ctx, agentId, id);
        if (entry === undefined) throw new Error(`Slot entry "${id}" does not exist.`);
        return entry;
    }

    #normalizePageQuery(query: SlotPageQuery): SlotPageQuery & { readonly limit: number } {
        const limit = query.limit ?? Math.min(this.#maxEntries, this.#maxPageSize);
        if (limit > this.#maxEntries || limit > this.#maxPageSize) {
            throw new Error("Slot page limit exceeds the configured bound.");
        }
        return { ...query, limit };
    }

    #validatePageEntries(entries: readonly SlotEntry[], query: SlotPageQuery): void {
        const ids = new Set<string>();
        let previousOrdering = -1;
        for (const entry of entries) {
            this.#validateEntry(entry);
            if (ids.has(entry.id)) throw new Error("Slot page contains duplicate entry IDs.");
            if (entry.ordering < previousOrdering) {
                throw new Error("Slot page is not deterministically ordered.");
            }
            if (!matchesQuery(entry, query)) {
                throw new Error("Slots database returned an entry outside the requested filter.");
            }
            ids.add(entry.id);
            previousOrdering = entry.ordering;
        }
    }

    #validateEntries(entries: readonly SlotEntry[]): void {
        if (entries.length > this.#maxEntries) {
            throw new Error("Slot catalog exceeds its configured bound.");
        }
        const ids = new Set<string>();
        const orderings = new Set<number>();
        for (const entry of entries) {
            this.#validateEntry(entry);
            if (ids.has(entry.id)) throw new Error("Slot entry IDs must be unique.");
            if (orderings.has(entry.ordering)) {
                throw new Error("Slot entry ordering values must be unique.");
            }
            ids.add(entry.id);
            orderings.add(entry.ordering);
        }
        const sorted = [...orderings].sort((left, right) => left - right);
        if (!sorted.every((ordering, index) => ordering === index)) {
            throw new Error("Slot entry ordering must be contiguous from zero.");
        }
    }

    #validateEntry(entry: SlotEntry): void {
        if (!Value.Check(slotEntrySchema, entry)) {
            throw new Error("Persisted slot entry has an invalid shape.");
        }
        if (!allowedSlotScopes[entry.slot].includes(entry.scope)) {
            throw new Error("Persisted slot entry uses an incompatible slot and scope.");
        }
        if (entry.updatedAt < entry.createdAt) {
            throw new Error("Persisted slot entry has an invalid timestamp order.");
        }
    }

    async #authorizeEntries(
        ctx: Context,
        requesterAgentId: string,
        entries: readonly SlotEntry[],
        operation: SlotReadOperation,
    ): Promise<void> {
        for (const entry of entries) {
            await this.#authorizeRead(ctx, requesterAgentId, entry.authorAgentId, operation);
        }
    }

    async #authorizeRead(
        ctx: Context,
        requesterAgentId: string,
        ownerAgentId: string,
        operation: SlotReadOperation,
    ): Promise<void> {
        if (requesterAgentId === ownerAgentId) return;
        const authorize = this.#readAuthorization;
        if (authorize === undefined) {
            throw new Error(
                `Agent "${requesterAgentId}" is not authorized to ${operation} slot entries owned by "${ownerAgentId}".`,
            );
        }
        const raw = authorize(ctx, requesterAgentId, ownerAgentId, operation);
        const allowed = isPromiseLike(raw) ? await raw : raw;
        if (allowed !== true) {
            throw new Error(
                `Agent "${requesterAgentId}" is not authorized to ${operation} slot entries owned by "${ownerAgentId}".`,
            );
        }
    }

    async #assertScope(
        ctx: Context,
        agentId: string,
        slot: SlotName,
        entry: SlotScopeReference,
    ): Promise<void> {
        if (!allowedSlotScopes[slot].includes(entry.scope)) {
            throw new Error(`The ${slot} slot does not allow the ${entry.scope} scope.`);
        }
        const raw = this.#scopeResolver(ctx, agentId, scopeReferenceFromEntry(entry));
        const resolved = isPromiseLike(raw) ? await raw : raw;
        if (resolved !== true) throw new Error(`The ${entry.scope} scope target does not exist.`);
    }

    async #validateScopeReferences(
        ctx: Context,
        agentId: string,
        entries: readonly SlotEntry[],
    ): Promise<void> {
        for (const entry of entries) {
            await this.#assertScope(ctx, agentId, entry.slot, entry);
        }
    }

    #assertCompleteOrder(entries: readonly SlotEntry[], entryIds: readonly string[]): void {
        if (
            entryIds.length !== entries.length ||
            !entryIds.every((id) => entries.some((entry) => entry.id === id))
        ) {
            throw new Error("Slot reorder must include every current entry exactly once.");
        }
    }

    #assertOwner(agentId: string, entry: SlotEntry): void {
        if (entry.authorAgentId !== agentId) {
            throw new Error(`Agent "${agentId}" is not the owner of slot entry "${entry.id}".`);
        }
    }

    async #newId(ctx: Context, agentId: string): Promise<string> {
        this.#assertAgentId(agentId);
        const raw = this.#idFactory(ctx, agentId);
        const id = isPromiseLike(raw) ? await raw : raw;
        this.#assertId(id);
        return id;
    }

    async #event(
        ctx: Context,
        payload:
            | {
                  readonly type: "slot_entry_created";
                  readonly agentId: string;
                  readonly entry: SlotEntry;
              }
            | {
                  readonly type: "slot_entry_updated";
                  readonly agentId: string;
                  readonly entry: SlotEntry;
                  readonly changes: SlotUpdateInput;
              }
            | {
                  readonly type: "slot_entries_reordered";
                  readonly agentId: string;
                  readonly entryIds: SlotReorderInput;
                  readonly entries: readonly SlotEntry[];
              }
            | {
                  readonly type: "slot_entry_removed";
                  readonly agentId: string;
                  readonly entry: SlotEntry;
                  readonly entryId: string;
              },
    ): Promise<SlotEvent> {
        const rawId = this.#eventIdFactory(ctx, payload.agentId);
        const eventId = isPromiseLike(rawId) ? await rawId : rawId;
        const at = this.#clock();
        const event = { ...payload, eventId, at };
        if (!Value.Check(slotEventSchema, event)) {
            throw new Error("Slots module created an invalid event.");
        }
        return structuredClone(event);
    }

    async #observe(ctx: Context, event: SlotEvent): Promise<void> {
        await this.#listener?.onEventTransactional?.(ctx, event);
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: SlotEvent): Promise<void> {
        const observers = [
            this.#listener?.onEvent === undefined
                ? undefined
                : () => this.#listener?.onEvent?.(ctx, event),
            () => this.#publisher(ctx, event),
        ];
        for (const observer of observers) {
            if (observer === undefined) continue;
            try {
                await observer();
            } catch (error: unknown) {
                try {
                    await this.#onPostCommitError?.(ctx, event, error);
                } catch {
                    // Reporting is advisory after durable state has committed.
                }
            }
        }
    }

    #formatEntries(entries: readonly SlotEntry[], maxCharacters: number): string {
        entries.forEach((entry) => this.#validateEntry(entry));
        if (entries.length === 0) return "No slot entries.";
        const ordered = [...entries].sort(compareEntries);
        const identities = ordered.map((entry) => entry.id).join("\n");
        if (identities.length > maxCharacters) {
            throw new Error("Slot model output cannot fit every returned entry identity.");
        }
        const detailed = ordered
            .map((entry) => {
                const content =
                    entry.content.type === "text"
                        ? `text: ${entry.content.markdown}`
                        : `button "${entry.content.label}" → ${JSON.stringify(entry.content.action)}`;
                return [
                    `${entry.id} [${entry.slot}, ${describeScope(entry)}]`,
                    `  ${content}`,
                    `  Description: ${entry.description}`,
                    `  Purpose: ${entry.purpose}`,
                    `  Author agent: ${entry.authorAgentId}`,
                ].join("\n");
            })
            .join("\n");
        return detailed.length <= maxCharacters ? detailed : identities;
    }

    #formatPage(page: SlotPage, maxCharacters: number): string {
        const rows =
            page.entries.length === 0
                ? "No slot entries."
                : page.entries
                      .map((entry) => `${entry.id} [${entry.slot}, ${describeScope(entry)}]`)
                      .join("\n");
        const identities =
            page.entries.length === 0
                ? "No slot entries."
                : page.entries.map((entry) => entry.id).join("\n");
        const withCursor = (value: string) =>
            page.nextCursor === undefined ? value : `${value}\nNext cursor: ${page.nextCursor}`;
        const detailed = withCursor(rows);
        const compact = withCursor(identities);
        if (compact.length > maxCharacters) {
            throw new Error("Slot page output cannot fit every returned identity and cursor.");
        }
        return detailed.length <= maxCharacters ? detailed : compact;
    }

    #fitDetailPage(page: Exclude<SlotDetailPage, { entry: null }>): SlotDetailPage {
        let detail = page.detail;
        for (;;) {
            const candidate = {
                ...page,
                detail,
                ...(page.detailOffset + detail.length < page.detailTotal
                    ? { nextDetailOffset: page.detailOffset + detail.length }
                    : {}),
            };
            if (
                formatSlotDetailPage(candidate, this.#maxOutputCharacters).length <=
                this.#maxOutputCharacters
            ) {
                return candidate;
            }
            if (detail.length <= 1) {
                throw new Error("Slots maxOutputCharacters is too small to expose slot detail.");
            }
            detail = detail.slice(0, Math.max(1, detail.length - 1));
        }
    }

    #fitReorderPage(entries: readonly SlotEntry[]): SlotPage {
        if (entries.length === 0) return { entries: [], limit: 1 };
        for (
            let visible = Math.min(entries.length, this.#maxPageSize);
            visible >= 1;
            visible -= 1
        ) {
            const page: SlotPage = {
                entries: entries.slice(0, visible),
                limit: visible,
                ...(visible < entries.length ? { nextCursor: visible } : {}),
            };
            if (this.formatReorderPageForModel(page).length <= this.#maxOutputCharacters) {
                return page;
            }
        }
        throw new Error("Slot reorder output cannot fit a complete entry identity and cursor.");
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Slot ${label} input is invalid.`);
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(slotAgentIdSchema, agentId)) {
            throw new Error("Slot acting agent ID is invalid.");
        }
    }

    #assertId(id: string): void {
        if (!Value.Check(slotIdSchema, id)) throw new Error("Slot entry ID is invalid.");
    }
}

export function assertSlotsModuleOptions(value: unknown): asserts value is SlotsModuleOptions {
    if (value === null || typeof value !== "object") {
        throw new Error("Slots module options are invalid.");
    }
    const options = value as Record<string, unknown>;
    const validation = {
        ...options,
        ...(options.listener === undefined
            ? {}
            : { listener: slotListenerValidationView(options.listener) }),
    };
    if (!Value.Check(slotModuleOptionsSchema, validation)) {
        throw new Error("Slots module options are invalid.");
    }
}

function normalizeCreateInput(input: SlotCreateInput): SlotCreateInput {
    const common = {
        ...(input.id === undefined ? {} : { id: input.id.trim() }),
        slot: input.slot,
        content: normalizeContent(input.content),
        description: normalizeRequired(input.description, slotDescriptionSchema),
        purpose: normalizeRequired(input.purpose, slotPurposeSchema),
    };
    const normalized: SlotCreateInput =
        input.scope === "everywhere"
            ? { ...common, scope: "everywhere" }
            : input.scope === "project"
              ? { ...common, scope: "project", projectId: input.projectId.trim() }
              : input.scope === "workspace"
                ? { ...common, scope: "workspace", workspaceId: input.workspaceId.trim() }
                : { ...common, scope: "session", sessionId: input.sessionId.trim() };
    if (!Value.Check(slotCreateInputSchema, normalized)) {
        throw new Error("Slot creation input is invalid after normalization.");
    }
    return normalized;
}

function withCreateIdentity(
    input: SlotCreateInput,
    id: string,
    authorAgentId: string,
): SlotStoreCreateInput {
    const common = {
        id,
        authorAgentId,
        slot: input.slot,
        content: input.content,
        description: input.description,
        purpose: input.purpose,
    };
    return input.scope === "everywhere"
        ? { ...common, scope: "everywhere" }
        : input.scope === "project"
          ? { ...common, scope: "project", projectId: input.projectId }
          : input.scope === "workspace"
            ? { ...common, scope: "workspace", workspaceId: input.workspaceId }
            : { ...common, scope: "session", sessionId: input.sessionId };
}

function normalizeUpdateInput(input: SlotUpdateInput): SlotUpdateInput {
    const normalized = {
        ...(input.slot === undefined ? {} : { slot: input.slot }),
        ...(input.content === undefined ? {} : { content: normalizeContent(input.content) }),
        ...(input.description === undefined
            ? {}
            : { description: normalizeRequired(input.description, slotDescriptionSchema) }),
        ...(input.purpose === undefined
            ? {}
            : { purpose: normalizeRequired(input.purpose, slotPurposeSchema) }),
    };
    if (!Value.Check(slotUpdateInputSchema, normalized)) {
        throw new Error("Slot update input is invalid after normalization.");
    }
    return normalized;
}

function normalizeContent(content: SlotContent): SlotContent {
    const clone = structuredClone(content);
    if (!Value.Check(slotContentSchema, clone)) throw new Error("Slot content is invalid.");
    return clone;
}

function normalizeRequired(value: string, schema: TSchema): string {
    const normalized = value.trim();
    if (!Value.Check(schema, normalized)) {
        throw new Error("Slot descriptive text is invalid.");
    }
    return normalized;
}

function sameCreation(entry: SlotEntry, request: SlotStoreCreateInput): boolean {
    return (
        entry.id === request.id &&
        entry.slot === request.slot &&
        entry.authorAgentId === request.authorAgentId &&
        sameJson(entry.content, request.content) &&
        entry.description === request.description &&
        entry.purpose === request.purpose &&
        sameJson(scopeReferenceFromEntry(entry), scopeReferenceFromEntry(request))
    );
}

function sameMutable(left: SlotEntry, right: SlotEntry): boolean {
    return (
        left.slot === right.slot &&
        sameJson(left.content, right.content) &&
        left.description === right.description &&
        left.purpose === right.purpose
    );
}

function sameUpdate(before: SlotEntry, after: SlotEntry, requested: SlotUpdateInput): boolean {
    return (
        before.id === after.id &&
        before.authorAgentId === after.authorAgentId &&
        before.createdAt === after.createdAt &&
        before.ordering === after.ordering &&
        sameJson(scopeReferenceFromEntry(before), scopeReferenceFromEntry(after)) &&
        after.updatedAt >= before.updatedAt &&
        after.slot === (requested.slot ?? before.slot) &&
        sameJson(after.content, requested.content ?? before.content) &&
        after.description === (requested.description ?? before.description) &&
        after.purpose === (requested.purpose ?? before.purpose)
    );
}

function sameReorderStableFields(before: SlotEntry, after: SlotEntry): boolean {
    return (
        before.id === after.id &&
        before.slot === after.slot &&
        before.authorAgentId === after.authorAgentId &&
        before.description === after.description &&
        before.purpose === after.purpose &&
        before.createdAt === after.createdAt &&
        after.updatedAt >= before.updatedAt &&
        sameJson(before.content, after.content) &&
        sameJson(scopeReferenceFromEntry(before), scopeReferenceFromEntry(after))
    );
}

function slotDetailText(entry: SlotEntry): string {
    return [
        `Content: ${JSON.stringify(entry.content)}`,
        `Description: ${entry.description}`,
        `Purpose: ${entry.purpose}`,
    ].join("\n");
}

function formatSlotDetailPage(
    page: Exclude<SlotDetailPage, { entry: null }>,
    maxCharacters: number,
): string {
    const full = [
        `${page.entry.id} [${page.entry.slot}, ${describeScope(page.entry)}]`,
        `Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More detail starts at offset ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (full.length <= maxCharacters) return full;
    return [
        page.entry.id,
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
}

function matchesQuery(entry: SlotEntry, query: SlotPageQuery): boolean {
    if (query.slot !== undefined && entry.slot !== query.slot) return false;
    if (!("scope" in query)) return true;
    switch (query.scope) {
        case "everywhere":
            return entry.scope === "everywhere";
        case "project":
            return entry.scope === "project" && entry.projectId === query.projectId;
        case "workspace":
            return entry.scope === "workspace" && entry.workspaceId === query.workspaceId;
        case "session":
            return entry.scope === "session" && entry.sessionId === query.sessionId;
    }
}

function compareEntries(left: SlotEntry, right: SlotEntry): number {
    return left.ordering - right.ordering || left.id.localeCompare(right.id);
}

function describeScope(entry: SlotEntry): string {
    switch (entry.scope) {
        case "everywhere":
            return "everywhere";
        case "project":
            return `project ${entry.projectId}`;
        case "workspace":
            return `workspace ${entry.workspaceId}`;
        case "session":
            return `session ${entry.sessionId}`;
    }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    );
}
