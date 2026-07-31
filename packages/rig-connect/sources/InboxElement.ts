import type { ConnectionState } from "./ChatElement.js";
import type { UserInputQuestion } from "./protocol.js";

export interface InboxItem {
    readonly answers?: Readonly<Record<string, readonly string[]>>;
    readonly createdAt: number;
    readonly id: string;
    readonly projectId: string;
    readonly questions: readonly UserInputQuestion[];
    readonly requestId: string;
    readonly resolvedAt?: number;
    readonly sessionId: string;
    readonly status: "pending" | "answered";
    readonly title?: string;
    readonly workspaceId?: string;
}

export interface InboxState {
    readonly connection: ConnectionState;
}

export type InboxDelta =
    | { readonly item: InboxItem; readonly type: "item_added" | "item_changed" }
    | { readonly id: string; readonly type: "item_removed" }
    | { readonly state: InboxState; readonly type: "inbox_state_changed" };
