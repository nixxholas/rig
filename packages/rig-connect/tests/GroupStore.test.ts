import { describe, expect, it } from "vitest";

import { GroupStore } from "@/GroupStore.js";
import type {
    GlobalEvent,
    GlobalStreamHello,
    Project,
    ProjectWorkspace,
    SessionSummary,
} from "@/protocol.js";

let clock = 0;

function project(id: string, overrides: Partial<Project> = {}): Project {
    return {
        createdAt: 1,
        id,
        initializationStatus: "ready",
        kind: "regular",
        name: id,
        nameSource: "folder",
        orderKey: id,
        path: `/work/${id}`,
        presence: "present",
        updatedAt: 1,
        version: 1,
        worktreeSupport: "supported",
        ...overrides,
    };
}

function workspace(
    id: string,
    projectId: string,
    overrides: Partial<ProjectWorkspace> = {},
): ProjectWorkspace {
    return {
        createdAt: 1,
        id,
        kind: "git_worktree",
        name: id,
        orderKey: id,
        path: `/work/${projectId}/${id}`,
        presence: "present",
        projectId,
        status: "ready",
        updatedAt: 1,
        version: 1,
        ...overrides,
    };
}

function session(id: string, projectId: string, workspaceId?: string): SessionSummary {
    return {
        archived: false,
        createdAt: 1,
        cwd: `/work/${projectId}`,
        id,
        modelId: "sonnet-5",
        orderKey: id,
        permissionMode: "auto",
        projectId,
        providerId: "claude",
        status: "idle",
        updatedAt: 1,
        ...(workspaceId === undefined ? {} : { workspaceId }),
    };
}

function hello(overrides: Partial<GlobalStreamHello> = {}): GlobalStreamHello {
    return {
        cursor: "c1",
        projects: [project("p1")],
        sessions: [session("s1", "p1")],
        sessionsComplete: true,
        workspaces: [],
        ...overrides,
    };
}

function event<TType extends string>(type: TType, data: unknown, scope: object = {}): GlobalEvent {
    clock += 1;
    return { createdAt: clock, data, id: `g${clock}`, type, ...scope } as unknown as GlobalEvent;
}

describe("GroupStore", () => {
    it("joins projects, worktrees, and sessions into one tree", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [session("s1", "p1"), session("s2", "p1", "w1")],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        const [group] = store.projects();
        // A client should not have to join three flat lists itself.
        expect(group?.sessions.map((item) => item.id)).toEqual(["s1"]);
        expect(group?.workspaces[0]?.sessions.map((item) => item.id)).toEqual(["s2"]);
    });

    it("orders projects, worktrees, and sessions the way the daemon ordered them", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("b"), project("a")],
                sessions: [session("s2", "a"), session("s1", "a")],
                workspaces: [workspace("w2", "a"), workspace("w1", "a")],
            }),
        );

        const groups = store.projects();
        expect(groups.map((group) => group.id)).toEqual(["a", "b"]);
        expect(groups[0]?.workspaces.map((item) => item.id)).toEqual(["w1", "w2"]);
        expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["s1", "s2"]);
    });

    it("keeps the identity of branches that did not change", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({ projects: [project("p1"), project("p2")], sessions: [session("s1", "p2")] }),
        );
        const before = store.projects();

        store.apply(
            event("session_created", { session: session("s2", "p2") }, { sessionId: "s2" }),
        );
        const after = store.projects();

        // React consumers rely on this: only the branch that changed gets a new
        // reference, so untouched subtrees do not re-render.
        expect(after).not.toBe(before);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
    });

    it("adds a project the daemon reports after the opening frame", () => {
        const store = new GroupStore();
        store.applyHello(hello());

        const deltas = store.apply(
            event("project_created", { project: project("p2") }, { projectId: "p2" }),
        );

        expect(store.projects().map((group) => group.id)).toEqual(["p1", "p2"]);
        expect(deltas).toContainEqual({ projectId: "p2", type: "project_added" });
    });

    it("ignores an older copy of an entity that arrives after a newer one", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        store.apply(
            event(
                "project_updated",
                { project: project("p1", { name: "Newer", version: 5 }) },
                { projectId: "p1" },
            ),
        );

        // Streams and snapshots race, so the store must merge by version rather
        // than by arrival order.
        const deltas = store.apply(
            event(
                "project_updated",
                { project: project("p1", { name: "Older", version: 2 }) },
                { projectId: "p1" },
            ),
        );

        expect(store.projects()[0]?.project.name).toBe("Newer");
        expect(deltas).toEqual([]);
    });

    it("attaches live Git state to the project it belongs to", () => {
        const store = new GroupStore();
        store.applyHello(hello());

        store.apply(
            event(
                "project_git_changed",
                { git: { changedFiles: 3, generation: "g1", version: 1 } },
                { projectId: "p1" },
            ),
        );

        expect(store.projects()[0]?.git).toMatchObject({ changedFiles: 3 });
    });

    it("does not let a stale Git snapshot overwrite a newer one", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        store.apply(
            event(
                "project_git_changed",
                { git: { changedFiles: 9, generation: "g1", version: 4 } },
                { projectId: "p1" },
            ),
        );

        const deltas = store.apply(
            event(
                "project_git_changed",
                { git: { changedFiles: 1, generation: "g1", version: 2 } },
                { projectId: "p1" },
            ),
        );

        expect(store.projects()[0]?.git).toMatchObject({ changedFiles: 9 });
        expect(deltas).toEqual([]);
    });

    it("takes a Git snapshot from a restarted daemon even though its version is lower", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        store.apply(
            event(
                "project_git_changed",
                { git: { changedFiles: 9, generation: "g1", version: 4 } },
                { projectId: "p1" },
            ),
        );

        // Versions are monotonic only within one daemon run, so a new generation
        // is newer regardless of its number.
        store.apply(
            event(
                "project_git_changed",
                { git: { changedFiles: 1, generation: "g2", version: 1 } },
                { projectId: "p1" },
            ),
        );

        expect(store.projects()[0]?.git).toMatchObject({ changedFiles: 1, generation: "g2" });
    });

    it("keeps live Git state across a reconnect that resends the group list", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        store.apply(
            event(
                "project_git_changed",
                { git: { changedFiles: 2, generation: "g1", version: 1 } },
                { projectId: "p1" },
            ),
        );

        store.applyHello(hello());

        // Git state is live-only and is replayed after the frame, but blanking it
        // here would flicker a branch the user is already looking at.
        expect(store.projects()[0]?.git).toMatchObject({ changedFiles: 2 });
    });

    it("moves a session when it changes worktree instead of showing it twice", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [session("s1", "p1")],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        store.apply(
            event(
                "session_updated",
                { session: { ...session("s1", "p1", "w1"), updatedAt: 5 } },
                { sessionId: "s1" },
            ),
        );

        const [group] = store.projects();
        expect(group?.sessions).toEqual([]);
        expect(group?.workspaces[0]?.sessions.map((item) => item.id)).toEqual(["s1"]);
    });

    it("takes an archived session out of the tree and puts it back when restored", () => {
        const store = new GroupStore();
        store.applyHello(hello());

        const removed = store.apply(
            event("session_archived", { archived: true }, { sessionId: "s1" }),
        );
        expect(store.projects()[0]?.sessions).toEqual([]);
        expect(removed).toContainEqual({ sessionId: "s1", type: "session_removed" });

        // Archiving and restoring report the same event type, so a store that
        // ignored the flag would hide the session for good.
        const restored = store.apply(
            event("session_archived", { archived: false }, { sessionId: "s1" }),
        );
        expect(store.projects()[0]?.sessions.map((item) => item.id)).toEqual(["s1"]);
        expect(restored).toContainEqual({ sessionId: "s1", type: "session_added" });
    });

    it("keeps summary fields a live session event does not carry", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [{ ...session("s1", "p1"), title: "Ship it" }] }));

        // Live events describe a session with a different, richer shape that has
        // no title-bearing summary fields; replacing rather than merging would
        // blank the title a client is already showing.
        store.apply(
            event(
                "session_updated",
                { session: { cwd: "/work/p1", id: "s1", projectId: "p1", status: "running" } },
                { sessionId: "s1" },
            ),
        );

        expect(store.projects()[0]?.sessions[0]).toMatchObject({
            status: "running",
            title: "Ship it",
        });
    });

    it("ignores a session event that arrives out of order", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        store.apply(
            event(
                "session_updated",
                { session: { ...session("s1", "p1"), title: "Newer" } },
                {
                    sessionId: "s1",
                },
            ),
        );
        const newerId = `g${clock}`;

        // Event ids are ordered, so an older copy overtaking a newer one on the
        // wire must not win.
        const stale = store.apply({
            createdAt: 1,
            data: { session: { ...session("s1", "p1"), title: "Older" } },
            id: `g${Number(newerId.slice(1)) - 1}`,
            sessionId: "s1",
            type: "session_updated",
        } as never);

        expect(store.projects()[0]?.sessions[0]?.title).toBe("Newer");
        expect(stale).toEqual([]);
    });

    it("refreshes a worktree session that changed without moving", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [session("s1", "p1", "w1")],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        store.apply(
            event(
                "session_updated",
                { session: { ...session("s1", "p1", "w1"), title: "Renamed" } },
                { sessionId: "s1" },
            ),
        );

        // The list looks unchanged by id, so a cache keyed on order alone would
        // hand back the session as it was before the rename.
        expect(store.projects()[0]?.workspaces[0]?.sessions[0]?.title).toBe("Renamed");
    });

    it("drops an archived project and its worktrees from the catalog", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1"), project("p2")],
                sessions: [],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        store.apply(
            event(
                "project_updated",
                { project: project("p1", { archivedAt: 99, version: 2 }) },
                { projectId: "p1" },
            ),
        );

        expect(store.projects().map((group) => group.id)).toEqual(["p2"]);
    });

    it("drops an archived worktree while keeping its project", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [],
                workspaces: [workspace("w1", "p1"), workspace("w2", "p1")],
            }),
        );

        store.apply(
            event(
                "workspace_updated",
                { workspace: workspace("w1", "p1", { status: "archived", version: 2 }) },
                { projectId: "p1" },
            ),
        );

        expect(store.projects()[0]?.workspaces.map((item) => item.id)).toEqual(["w2"]);
    });

    it("follows a session title as the daemon learns and clears it", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(
            event(
                "session_title_changed",
                { status: "ready", title: "Ship it" },
                {
                    sessionId: "s1",
                },
            ),
        );
        expect(store.projects()[0]?.sessions[0]?.title).toBe("Ship it");

        store.apply(event("session_title_changed", { status: "pending" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.sessions[0]?.title).toBeUndefined();
    });

    it("shows a session as working while a run is in flight", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(event("session_status_changed", { status: "running" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.sessions[0]?.status).toBe("running");

        // The daemon names the status a run settles at, so the sidebar shows
        // that word rather than one inferred from the run ending.
        store.apply(event("session_status_changed", { status: "completed" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.sessions[0]?.status).toBe("completed");
    });

    it("shows a lifecycle status that no run boundary implies", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(event("session_status_changed", { status: "suspended" }, { sessionId: "s1" }));

        // Suspended, aborted, and error are states a sidebar has to distinguish
        // from idle, and no run event says which of them a session reached.
        expect(store.projects()[0]?.sessions[0]?.status).toBe("suspended");
    });

    it("keeps the newer status when an older event arrives late", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        const stale = event("session_status_changed", { status: "running" }, { sessionId: "s1" });
        const fresh = event("session_status_changed", { status: "error" }, { sessionId: "s1" });
        store.apply({ ...fresh, id: "g-0002" });
        store.apply({ ...stale, id: "g-0001" });

        // Streams run in parallel, so a late delivery must not resurrect a status
        // the session has already moved past.
        expect(store.projects()[0]?.sessions[0]?.status).toBe("error");
    });

    it("reports that older sessions exist beyond the opening frame", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessionsComplete: false }));

        expect(store.state().sessionsComplete).toBe(false);
    });

    it("reports the connection state so a stall is visible rather than silent", () => {
        const store = new GroupStore();
        expect(store.state().connection).toBe("connecting");

        const deltas = store.setConnection("reconnecting");

        expect(store.state().connection).toBe("reconnecting");
        expect(deltas).toEqual([{ state: store.state(), type: "groups_state_changed" }]);
        expect(store.setConnection("reconnecting")).toEqual([]);
    });

    it("ignores session events that say nothing about where a session belongs", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        const before = store.projects();

        const deltas = store.apply(
            event("agent_event", { event: { type: "text_start" } }, { sessionId: "s1" }),
        );

        expect(deltas).toEqual([]);
        expect(store.projects()).toBe(before);
    });
});
