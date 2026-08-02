import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";

import { inTx } from "../persistence/inTx.js";
import { querySlotEntries } from "../persistence/slots/querySlotEntries.js";
import { querySlotEntry } from "../persistence/slots/querySlotEntry.js";
import { querySlotScopeTargetExists } from "../persistence/slots/querySlotScopeTargetExists.js";
import { slotEntryCreate } from "../persistence/slots/slotEntryCreate.js";
import { slotEntryRemove } from "../persistence/slots/slotEntryRemove.js";
import { slotEntriesRemoveByPluginAuthor } from "../persistence/slots/slotEntriesRemoveByPluginAuthor.js";
import { slotEntryUpdate } from "../persistence/slots/slotEntryUpdate.js";
import type { TX } from "../persistence/Transaction.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import {
    createSlotEntryRequestSchema,
    updateSlotEntryRequestSchema,
    type CreateSlotEntryRequest,
    type SlotEntry,
    type SlotEntryFilter,
    type SlotsChangedEvent,
    type UpdateSlotEntryRequest,
} from "../protocol/SlotProtocol.js";
import type { Webapp } from "../protocol/WebappProtocol.js";
import { allowedSlotScopes, describeAllowedScopesForSlot } from "../protocol/SlotScopeRules.js";
import { describeWebappScopeNotAllowed } from "../webapps/describeWebappScopeNotAllowed.js";
import { SlotEntryInvalidError } from "./SlotEntryInvalidError.js";
import { SlotEntryNotFoundError } from "./SlotEntryNotFoundError.js";

export interface SlotEntryStoreOptions {
    now?: () => number;
    /** Delivers a change to the live global stream after the database write committed. */
    publish: (event: SlotsChangedEvent) => void;
    /**
     * Whether a session id names a live session. The in-memory store holds sessions outside
     * SQLite, so the slot store asks its owner instead of the sessions table.
     */
    sessionExists: (sessionId: string) => boolean;
    tx: () => TX;
    webapp: (name: string) => Webapp | undefined;
}

/**
 * Owns every slot entry: agent- and plugin-authored content plugged into fixed Happy UI slots.
 *
 * Rig verifies types only — an unknown slot, scope, content shape, or dangling scope reference is
 * rejected with a typed error, and the content itself is never interpreted. Every change persists
 * first and then publishes `slots_changed` with the whole current set, so clients stay current
 * without polling.
 */
export class SlotEntryStore {
    readonly #createEventId = createEventIdFactory();
    readonly #now: () => number;
    readonly #publish: (event: SlotsChangedEvent) => void;
    readonly #sessionExists: (sessionId: string) => boolean;
    readonly #tx: () => TX;
    readonly #webapp: (name: string) => Webapp | undefined;

    constructor(options: SlotEntryStoreOptions) {
        this.#now = options.now ?? Date.now;
        this.#publish = options.publish;
        this.#sessionExists = options.sessionExists;
        this.#tx = options.tx;
        this.#webapp = options.webapp;
    }

    create(request: CreateSlotEntryRequest): SlotEntry {
        if (!Value.Check(createSlotEntryRequestSchema, request)) {
            throw new SlotEntryInvalidError(describeInvalid(createSlotEntryRequestSchema, request));
        }
        requireAllowedSlotScope(request.slot, request.scope);
        this.#requireWebappScope(request.content, request.scope);
        const now = this.#now();
        const entry: SlotEntry = {
            id: createId(),
            slot: request.slot,
            scope: request.scope,
            ...scopeReference(request),
            content: request.content,
            author: request.author,
            description: request.description,
            purpose: request.purpose,
            createdAt: now,
            updatedAt: now,
        };
        const created = inTx(this.#tx(), (tx) => {
            this.#requireScopeTarget(tx, entry);
            slotEntryCreate(tx, entry);
            return querySlotEntry(tx, entry.id);
        });
        this.#publishChanged();
        return created ?? entry;
    }

    list(filter: SlotEntryFilter = {}): readonly SlotEntry[] {
        return querySlotEntries(this.#tx(), filter);
    }

    remove(id: string): SlotEntry {
        const removed = inTx(this.#tx(), (tx) => {
            const entry = querySlotEntry(tx, id);
            if (entry === undefined) {
                throw new SlotEntryNotFoundError(`No slot entry with the id ${id} exists.`);
            }
            slotEntryRemove(tx, id);
            return entry;
        });
        this.#publishChanged();
        return removed;
    }

    /** Removes the entries whose author disappeared with an uninstalled plugin. */
    removeByPluginAuthor(folder: string): number {
        const removed = inTx(this.#tx(), (tx) => slotEntriesRemoveByPluginAuthor(tx, folder));
        if (removed > 0) this.#publishChanged();
        return removed;
    }

    update(id: string, request: UpdateSlotEntryRequest): SlotEntry {
        if (!Value.Check(updateSlotEntryRequestSchema, request)) {
            throw new SlotEntryInvalidError(describeInvalid(updateSlotEntryRequestSchema, request));
        }
        const updated = inTx(this.#tx(), (tx) => {
            const existing = querySlotEntry(tx, id);
            if (existing === undefined) {
                throw new SlotEntryNotFoundError(`No slot entry with the id ${id} exists.`);
            }
            const entry: SlotEntry = {
                ...existing,
                ...(request.slot === undefined ? {} : { slot: request.slot }),
                ...(request.content === undefined ? {} : { content: request.content }),
                ...(request.description === undefined ? {} : { description: request.description }),
                ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
                updatedAt: this.#now(),
            };
            if (request.slot !== undefined) {
                requireAllowedSlotScope(entry.slot, entry.scope);
            }
            if (request.slot !== undefined || request.content !== undefined) {
                this.#requireWebappScope(entry.content, entry.scope);
            }
            slotEntryUpdate(tx, entry);
            return entry;
        });
        this.#publishChanged();
        return updated;
    }

    #publishChanged(): void {
        this.#publish({
            createdAt: this.#now(),
            data: { entries: this.list() },
            id: this.#createEventId(),
            type: "slots_changed",
        });
    }

    #requireScopeTarget(tx: TX, entry: SlotEntry): void {
        if (entry.scope === "everywhere") return;
        const id =
            entry.scope === "project"
                ? entry.projectId
                : entry.scope === "workspace"
                  ? entry.workspaceId
                  : entry.sessionId;
        if (id === undefined) {
            throw new SlotEntryInvalidError(
                `A ${entry.scope}-scoped slot entry needs the matching ${entry.scope} id.`,
            );
        }
        const exists =
            entry.scope === "session"
                ? this.#sessionExists(id)
                : querySlotScopeTargetExists(tx, entry.scope, id);
        if (!exists) {
            throw new SlotEntryInvalidError(
                `The ${entry.scope} ${id} the slot entry points at does not exist.`,
            );
        }
    }

    #requireWebappScope(content: SlotEntry["content"], scope: SlotEntry["scope"]): void {
        if (content.type !== "button" || content.action.type !== "open-webapp") return;
        const webapp = this.#webapp(content.action.webapp);
        if (webapp === undefined || webapp.allowedScopes.includes(scope)) return;
        throw new SlotEntryInvalidError(describeWebappScopeNotAllowed(webapp, scope));
    }
}

/** Exactly the reference matching the scope is kept; the others are rejected. */
function scopeReference(
    request: CreateSlotEntryRequest,
): Pick<SlotEntry, "projectId" | "sessionId" | "workspaceId"> {
    const provided = [
        ...(request.projectId === undefined ? [] : (["project"] as const)),
        ...(request.workspaceId === undefined ? [] : (["workspace"] as const)),
        ...(request.sessionId === undefined ? [] : (["session"] as const)),
    ];
    const expected = request.scope === "everywhere" ? [] : [request.scope];
    if (
        provided.length !== expected.length ||
        (expected[0] !== undefined && provided[0] !== expected[0])
    ) {
        throw new SlotEntryInvalidError(
            request.scope === "everywhere"
                ? "An everywhere-scoped slot entry must not reference a project, workspace, or session."
                : `A ${request.scope}-scoped slot entry must reference exactly its ${request.scope}.`,
        );
    }
    if (request.scope === "project") return { projectId: request.projectId! };
    if (request.scope === "workspace") return { workspaceId: request.workspaceId! };
    if (request.scope === "session") return { sessionId: request.sessionId! };
    return {};
}

function describeInvalid(schema: Parameters<typeof Value.Errors>[0], value: unknown): string {
    const first = Value.Errors(schema, value).First();
    if (first === undefined) return "The slot entry is invalid.";
    const where = first.path === "" ? "" : ` at ${first.path}`;
    return `The slot entry is invalid${where}: ${first.message}.`;
}

function requireAllowedSlotScope(slot: SlotEntry["slot"], scope: SlotEntry["scope"]): void {
    if (allowedSlotScopes[slot].some((allowedScope) => allowedScope === scope)) return;
    throw new SlotEntryInvalidError(describeAllowedScopesForSlot(slot));
}
