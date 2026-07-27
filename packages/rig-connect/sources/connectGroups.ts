import { GroupStore } from "./GroupStore.js";
import { streamGlobalEvents } from "./streamGlobalEvents.js";
import type { GroupDelta, GroupsState, ProjectGroup } from "./GroupElement.js";

export interface ConnectGroupsOptions {
    /** Base URL of a Rig endpoint serving the protocol over HTTP. */
    endpoint: string;
    /** Bearer token for the endpoint. Obtaining it is the caller's job. */
    token: string;
    /** Receives the current project tree whenever anything in it changes. */
    onChange: (projects: readonly ProjectGroup[], state: GroupsState) => void;
    /** Receives ordered deltas. Never called before `onChange`. */
    onDelta?: (delta: GroupDelta) => void;
    /** Reports a failure that ended the connection for good. */
    onError?: (error: unknown) => void;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
}

export interface GroupsConnection {
    /** The current project tree. Same identity until something changes. */
    projects: () => readonly ProjectGroup[];
    state: () => GroupsState;
    /** Releases every resource held by this connection. */
    close: () => void;
}

/**
 * Subscribes to the live state of the group catalog.
 *
 * This is the companion to `connectSession`: it answers what projects,
 * worktrees, and sessions exist, while a session connection answers what is
 * happening inside one of them. It opens one stream and never issues a
 * follow-up request to interpret something it was just told.
 */
export function connectGroups(options: ConnectGroupsOptions): GroupsConnection {
    const store = new GroupStore();
    const controller = new AbortController();
    let closed = false;

    const publish = (deltas: readonly GroupDelta[]): void => {
        if (closed || deltas.length === 0) return;
        // The tree is handed over before the deltas, so a consumer reacting to a
        // delta always reads state that already reflects it.
        options.onChange(store.projects(), store.state());
        for (const delta of deltas) options.onDelta?.(delta);
    };

    publish(store.setConnection("connecting"));

    void streamGlobalEvents({
        endpoint: options.endpoint,
        signal: controller.signal,
        token: options.token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        onHello: (hello) => {
            const deltas = store.applyHello(hello);
            publish([...store.setConnection("live"), ...deltas]);
        },
        onEvent: (event) => publish(store.apply(event)),
        onDisconnected: () => publish(store.setConnection("reconnecting")),
    })
        .catch((error: unknown) => {
            if (closed) return;
            publish(store.setConnection("closed"));
            options.onError?.(error);
        })
        .finally(() => {
            if (!closed) publish(store.setConnection("closed"));
        });

    return {
        projects: () => store.projects(),
        state: () => store.state(),
        close: () => {
            if (closed) return;
            closed = true;
            controller.abort();
        },
    };
}
