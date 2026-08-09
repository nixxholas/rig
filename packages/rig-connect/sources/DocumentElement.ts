import type { ConnectionState, MutationRejectedDelta } from "./ChatElement.js";
import type { Document, DocumentUpdate } from "./protocol.js";

export type { Document, DocumentUpdate };

/** The portion of a document's retained update queue currently held by the client. */
export interface DocumentUpdatesState {
    readonly currentVersion?: number;
    readonly firstRetainedVersion?: number;
    /** The daemon could not provide a continuous page from the requested version. */
    readonly gap?: boolean;
    readonly hasMore?: boolean;
    readonly loading: boolean;
    /** Cursor to use when loading the next bounded page. */
    readonly nextAfterVersion?: number;
}

/** Everything a document consumer needs to render its live state. */
export interface DocumentState {
    readonly connection: ConnectionState;
    readonly document?: Document;
    /**
     * A light stream event reported a newer document version. The current opaque
     * state is intentionally not guessed from that event and must be reloaded.
     */
    readonly reloadNeeded: boolean;
    readonly updates: DocumentUpdatesState;
}

export type DocumentDelta =
    | { readonly document?: Document; readonly type: "document_changed" }
    | { readonly state: DocumentState; readonly type: "document_state_changed" }
    | { readonly type: "document_updates_changed"; readonly updates: readonly DocumentUpdate[] }
    | MutationRejectedDelta;
