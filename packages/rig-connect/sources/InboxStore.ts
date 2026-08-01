import type { InboxDelta, InboxItem, InboxState } from "./InboxElement.js";
import type {
    GlobalEvent,
    GlobalStreamHello,
    SessionSummary,
    UserInputRequest,
} from "./protocol.js";

export class InboxStore {
    #items: readonly InboxItem[] = [];
    #sessions = new Map<string, SessionSummary>();
    #state: InboxState = { connection: "connecting" };

    items(): readonly InboxItem[] {
        return this.#items;
    }

    state(): InboxState {
        return this.#state;
    }

    setConnection(connection: InboxState["connection"]): InboxDelta[] {
        if (this.#state.connection === connection) return [];
        this.#state = { connection };
        return [{ state: this.#state, type: "inbox_state_changed" }];
    }

    applyHello(hello: GlobalStreamHello): InboxDelta[] {
        this.#sessions = new Map(hello.sessions.map((session) => [session.id, session]));
        return this.#replaceItems(sortItems(hello.sessions.flatMap(itemsForSession)));
    }

    #replaceItems(next: readonly InboxItem[]): InboxDelta[] {
        const previous = new Map(this.#items.map((item) => [item.id, item]));
        const deltas: InboxDelta[] = [];
        const retained = next.map((item) => {
            const before = previous.get(item.id);
            if (before === undefined) deltas.push({ item, type: "item_added" });
            else if (JSON.stringify(before) !== JSON.stringify(item)) {
                deltas.push({ item, type: "item_changed" });
            }
            previous.delete(item.id);
            return before !== undefined && JSON.stringify(before) === JSON.stringify(item)
                ? before
                : item;
        });
        for (const id of previous.keys()) deltas.push({ id, type: "item_removed" });
        this.#items = retained;
        return deltas;
    }

    apply(event: GlobalEvent): InboxDelta[] {
        if (!("sessionId" in event)) return [];
        if (event.type === "user_input_requested") {
            const request = event.data as UserInputRequest;
            const session = this.#sessions.get(event.sessionId);
            const id = inboxItemId(event.sessionId, request.requestId);
            const existing = this.#items.find((item) => item.id === id);
            const item: InboxItem = {
                createdAt: event.createdAt,
                id,
                projectId: session?.projectId ?? "",
                questions: request.questions,
                requestId: request.requestId,
                sessionId: event.sessionId,
                status: "pending",
                ...(session?.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            };
            this.#items = sortItems([
                ...this.#items.filter((candidate) => candidate.id !== item.id),
                item,
            ]);
            return [{ item, type: existing === undefined ? "item_added" : "item_changed" }];
        }
        if (event.type === "user_input_resolved") {
            const resolution = event.data as {
                answers?: Readonly<Record<string, readonly string[]>>;
                requestId: string;
                status: string;
            };
            const existing = this.#items.find(
                (item) => item.id === inboxItemId(event.sessionId, resolution.requestId),
            );
            if (existing === undefined) return [];
            if (resolution.status !== "answered") {
                this.#items = this.#items.filter((item) => item.id !== existing.id);
                return [{ id: existing.id, type: "item_removed" }];
            }
            const item: InboxItem = {
                ...existing,
                answers: resolution.answers ?? {},
                resolvedAt: event.createdAt,
                status: "answered",
            };
            this.#items = sortItems([
                ...this.#items.filter((candidate) => candidate.id !== item.id),
                item,
            ]);
            return [{ item, type: "item_changed" }];
        }
        if (event.type === "session_current") {
            const current = event.data as { session: SessionSummary };
            this.#sessions.set(event.sessionId, current.session);
            const ids = new Set(
                (current.session.inboxItems ?? []).map((item) =>
                    inboxItemId(event.sessionId, item.requestId),
                ),
            );
            const next = [
                ...this.#items.filter(
                    (item) => item.sessionId !== event.sessionId || ids.has(item.id),
                ),
                ...itemsForSession(current.session),
            ];
            return this.#replaceItems(sortItems(dedupe(next)));
        }
        return [];
    }
}

function itemsForSession(session: SessionSummary): InboxItem[] {
    return (session.inboxItems ?? []).map((item) => ({
        createdAt: item.createdAt,
        id: inboxItemId(session.id, item.requestId),
        projectId: session.projectId,
        questions: item.questions,
        requestId: item.requestId,
        sessionId: session.id,
        status: item.status,
        ...(item.answers === undefined ? {} : { answers: item.answers }),
        ...(item.resolvedAt === undefined ? {} : { resolvedAt: item.resolvedAt }),
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    }));
}

function inboxItemId(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
}

function dedupe(items: readonly InboxItem[]): InboxItem[] {
    return [...new Map(items.map((item) => [item.id, item])).values()];
}

function sortItems(items: readonly InboxItem[]): InboxItem[] {
    return [...items].sort((left, right) => {
        if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
        if (left.status === "answered") {
            return (right.resolvedAt ?? 0) - (left.resolvedAt ?? 0);
        }
        return left.createdAt - right.createdAt;
    });
}
