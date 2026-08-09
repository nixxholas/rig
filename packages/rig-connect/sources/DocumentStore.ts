import { Value } from "@sinclair/typebox/value";

import type { ConnectionState } from "./ChatElement.js";
import { documentEventSchema } from "./protocol.js";
import type {
    Document,
    DocumentEvent,
    DocumentUpdate,
    DocumentUpdatePage,
    GlobalEvent,
} from "./protocol.js";
import type { DocumentDelta, DocumentState, DocumentUpdatesState } from "./DocumentElement.js";

const INITIAL_UPDATES_STATE: DocumentUpdatesState = { loading: false };

/**
 * Browser-safe live state for one opaque document.
 *
 * The store does not interpret document state or updates. It only keeps the
 * authoritative snapshot, predicts one compare-version-and-write locally, and
 * merges bounded update pages by version.
 */
export class DocumentStore {
    #documentId: string | undefined;
    #state: DocumentState = {
        connection: "connecting",
        reloadNeeded: false,
        updates: INITIAL_UPDATES_STATE,
    };
    #updates: readonly DocumentUpdate[] = [];

    constructor(documentId?: string) {
        this.#documentId = documentId;
    }

    document(): Document | undefined {
        return this.#state.document;
    }

    documentId(): string | undefined {
        return this.#documentId;
    }

    state(): DocumentState {
        return this.#state;
    }

    updates(): readonly DocumentUpdate[] {
        return this.#updates;
    }

    setConnection(connection: ConnectionState): DocumentDelta[] {
        if (this.#state.connection === connection) return [];
        return this.#setState({ ...this.#state, connection });
    }

    /**
     * Applies an ordinary snapshot. An older snapshot cannot replace an already
     * observed version; conflict handling uses `applyAuthoritativeDocument`.
     */
    applyDocument(document: Document): DocumentDelta[] {
        if (!this.#accepts(document.id)) return [];
        const current = this.#state.document;
        if (current !== undefined && current.version > document.version) return [];
        return this.#replaceDocument(document, true);
    }

    /**
     * Replaces a local prediction with the daemon's conflict response, even
     * when that response has a lower version than the predicted value.
     */
    applyAuthoritativeDocument(document: Document): DocumentDelta[] {
        return this.#accepts(document.id) ? this.#replaceDocument(document, true) : [];
    }

    applySnapshot(document: Document, page?: DocumentUpdatePage): DocumentDelta[] {
        const deltas = this.applyAuthoritativeDocument(document);
        return page === undefined ? deltas : [...deltas, ...this.applyUpdatePage(page)];
    }

    /**
     * A document event deliberately contains no opaque state. It therefore only
     * tells consumers to reload, never manufactures a document or update.
     */
    apply(event: GlobalEvent | DocumentEvent): DocumentDelta[] {
        if (!Value.Check(documentEventSchema, event)) return [];
        const { documentId } = event.data;
        if (!this.#accepts(documentId) || this.#state.reloadNeeded) {
            return [];
        }
        return this.#setState({ ...this.#state, reloadNeeded: true });
    }

    /**
     * Predicts a compare-version-and-write response. Omitted optional fields
     * remain untouched.
     */
    applyOptimisticPatch(patch: {
        readonly mimeType?: string;
        readonly state: unknown;
        readonly unreadCursor?: string | null;
        readonly updatedAt?: number;
    }): { deltas: readonly DocumentDelta[]; undo: () => void } {
        const current = this.#state.document;
        if (current === undefined) return { deltas: [], undo: () => undefined };
        const updated: Document = {
            ...current,
            state: patch.state,
            updatedAt: patch.updatedAt ?? current.updatedAt,
            version: current.version + 1,
            ...("mimeType" in patch ? { mimeType: patch.mimeType ?? current.mimeType } : {}),
        };
        if ("unreadCursor" in patch) {
            if (patch.unreadCursor === null) {
                delete updated.unreadCursor;
            } else if (patch.unreadCursor !== undefined) {
                updated.unreadCursor = patch.unreadCursor;
            }
        }
        const deltas = this.#replaceDocument(updated, false);
        return {
            deltas,
            undo: () => {
                if (this.#state.document !== updated) return;
                this.#replaceDocument(current, false);
            },
        };
    }

    startLoadingUpdates(): DocumentDelta[] {
        if (this.#state.updates.loading) return [];
        return this.#setState({
            ...this.#state,
            updates: { ...this.#state.updates, loading: true },
        });
    }

    failLoadingUpdates(): DocumentDelta[] {
        if (!this.#state.updates.loading) return [];
        return this.#setState({
            ...this.#state,
            updates: { ...this.#state.updates, loading: false },
        });
    }

    /**
     * Merges a bounded page without replacing unchanged update values. Holes in
     * a supposedly complete retained queue are exposed in state so an app never
     * mistakes a partial update log for a continuous one.
     */
    applyUpdatePage(page: DocumentUpdatePage): DocumentDelta[] {
        const previousUpdates = this.#updates;
        const updatesByVersion = new Map(
            previousUpdates
                .filter((update) => update.version >= page.firstRetainedVersion)
                .map((update) => [update.version, update]),
        );
        for (const update of page.updates) {
            if (this.#documentId !== undefined && update.documentId !== this.#documentId) continue;
            const known = updatesByVersion.get(update.version);
            updatesByVersion.set(
                update.version,
                known !== undefined && sameValue(known, update) ? known : update,
            );
        }
        const nextUpdates = [...updatesByVersion.values()].sort(byVersion);
        const updates = sameItems(previousUpdates, nextUpdates)
            ? previousUpdates
            : (nextUpdates as readonly DocumentUpdate[]);
        const updatesState: DocumentUpdatesState = {
            currentVersion: page.currentVersion,
            firstRetainedVersion: page.firstRetainedVersion,
            gap: this.#state.updates.gap === true || page.gap,
            hasMore: page.hasMore,
            loading: false,
            nextAfterVersion: page.nextAfterVersion,
        };
        const stateChanged = !sameValue(this.#state.updates, updatesState);
        this.#updates = updates;
        if (!stateChanged && updates === previousUpdates) return [];
        const previous = this.#state;
        this.#state = stateChanged ? { ...previous, updates: updatesState } : previous;
        return [
            ...(updates !== previousUpdates
                ? ([{ type: "document_updates_changed", updates }] as const)
                : []),
            ...(stateChanged
                ? ([{ state: this.#state, type: "document_state_changed" }] as const)
                : []),
        ];
    }

    #accepts(documentId: string): boolean {
        if (this.#documentId !== undefined) return this.#documentId === documentId;
        this.#documentId = documentId;
        return true;
    }

    #replaceDocument(document: Document, clearReloadNeeded: boolean): DocumentDelta[] {
        const current = this.#state.document;
        const nextDocument =
            current !== undefined && sameValue(current, document) ? current : document;
        const reloadNeeded = clearReloadNeeded ? false : this.#state.reloadNeeded;
        const previousUpdates = this.#updates;
        const resetUpdates = clearReloadNeeded && this.#state.updates.gap === true;
        const updates = resetUpdates ? [] : previousUpdates;
        const updatesState = resetUpdates ? INITIAL_UPDATES_STATE : this.#state.updates;
        if (
            nextDocument === current &&
            reloadNeeded === this.#state.reloadNeeded &&
            updates === previousUpdates
        ) {
            return [];
        }
        this.#updates = updates;
        const previous = this.#state;
        this.#state = {
            ...previous,
            document: nextDocument,
            reloadNeeded,
            updates: updatesState,
        };
        return [
            ...(nextDocument === current
                ? []
                : ([{ document: nextDocument, type: "document_changed" }] as const)),
            ...(updates === previousUpdates
                ? []
                : ([{ type: "document_updates_changed", updates }] as const)),
            { state: this.#state, type: "document_state_changed" },
        ];
    }

    #setState(state: DocumentState): DocumentDelta[] {
        if (sameValue(this.#state, state)) return [];
        this.#state = state;
        return [{ state, type: "document_state_changed" }];
    }
}

function byVersion(left: DocumentUpdate, right: DocumentUpdate): number {
    return left.version === right.version
        ? left.id < right.id
            ? -1
            : left.id > right.id
              ? 1
              : 0
        : left.version - right.version;
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
