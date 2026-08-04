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
        initializationAttempt: 1,
        initializationStatus: "ready",
        kind: "regular",
        name: id,
        nameSource: "folder",
        orderKey: id,
        path: `/work/${id}`,
        presence: "present",
        settings: {},
        storageKey: id,
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
    const base: ProjectWorkspace = {
        createdAt: 1,
        gitCommonDir: `/work/${projectId}/.git`,
        id,
        kind: "git_worktree",
        name: id,
        orderKey: id,
        path: `/work/${projectId}/${id}`,
        presence: "present",
        projectId,
        status: "ready",
        storageKey: id,
        updatedAt: 1,
        version: 1,
    };
    return { ...base, ...overrides };
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
        titleStatus: "idle",
        updatedAt: 1,
        ...(workspaceId === undefined ? {} : { workspaceId }),
    };
}

function hello(overrides: Partial<GlobalStreamHello> = {}): GlobalStreamHello {
    return {
        catalog: {
            defaultModelId: "sonnet-5",
            defaultProviderId: "claude",
            models: [],
            providers: [],
        },
        cursor: "c1",
        identity: { version: "test" },
        presence: {
            presence: {
                answerWaitMs: null,
                emoji: "🟢",
                id: "online",
                prompt: "The user is at the keyboard.",
                title: "Online",
            },
            presences: [
                {
                    answerWaitMs: null,
                    emoji: "🟢",
                    id: "online",
                    prompt: "The user is at the keyboard.",
                    title: "Online",
                },
            ],
            since: 0,
        },
        protocolVersion: 6,
        projects: [project("p1")],
        sessions: [session("s1", "p1")],
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
        ...overrides,
    };
}

describe("GroupStore and sessions that are not in the list", () => {
    it("keeps a subagent out of the sidebar however it arrives", () => {
        const store = new GroupStore();
        // Absent, not present-and-empty: the session has no position at all.
        const { orderKey: _position, ...subagent } = session("sub-1", "p1");

        // The catalog is one way in.
        store.applyHello(hello({ sessions: [session("s1", "p1"), subagent] }));
        expect(store.projects()[0]?.sessions.map((entry) => entry.id)).toEqual(["s1"]);

        // The live stream is the other, and it is the one that used to leak.
        store.apply(event("session_created", { session: subagent }, { sessionId: subagent.id }));
        expect(store.projects()[0]?.sessions.map((entry) => entry.id)).toEqual(["s1"]);

        store.apply(
            event(
                "session_updated",
                { session: { ...subagent, title: "Reviewing the diff" } },
                { sessionId: subagent.id },
            ),
        );
        expect(store.projects()[0]?.sessions.map((entry) => entry.id)).toEqual(["s1"]);
    });

    it("holds an order two sessions cannot argue about", () => {
        const store = new GroupStore();
        // Sessions that share a position must still have one settled order, or
        // the sidebar reshuffles under the reader on every rebuild.
        const first = { ...session("b-session", "p1"), orderKey: "a0" };
        const second = { ...session("a-session", "p1"), orderKey: "a0" };

        store.applyHello(hello({ sessions: [first, second] }));
        expect(store.projects()[0]?.sessions.map((entry) => entry.id)).toEqual([
            "a-session",
            "b-session",
        ]);

        const rebuilt = new GroupStore();
        rebuilt.applyHello(hello({ sessions: [second, first] }));
        expect(rebuilt.projects()[0]?.sessions.map((entry) => entry.id)).toEqual([
            "a-session",
            "b-session",
        ]);
    });
});

describe("GroupStore workspace predictions", () => {
    it("keeps an archived workspace absent across a newer reconnect snapshot", () => {
        const store = new GroupStore();
        store.applyHello(hello({ workspaces: [workspace("w1", "p1")] }));

        store.applyOptimisticWorkspaceArchived("p1", "w1");
        expect(store.projects()[0]?.workspaces).toEqual([]);

        store.applyHello(
            hello({
                cursor: "c2",
                workspaces: [workspace("w1", "p1", { updatedAt: 2, version: 2 })],
            }),
        );
        expect(store.projects()[0]?.workspaces).toEqual([]);
    });

    it("replaces one optimistic creation with one authoritative workspace", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        const pending = workspace("pending:mutation-1", "p1", {
            name: "Feature",
            status: "initializing",
            version: 0,
        });

        const prediction = store.applyOptimisticWorkspaceCreate(pending);
        expect(store.projects()[0]?.workspaces.map((item) => item.id)).toEqual([pending.id]);

        prediction.undo();
        store.apply(
            event(
                "workspace_created",
                {
                    mutationId: "mutation-1",
                    workspace: workspace("w1", "p1", { name: "Feature" }),
                },
                { projectId: "p1", workspaceId: "w1" },
            ),
        );
        expect(store.projects()[0]?.workspaces.map((item) => item.id)).toEqual(["w1"]);
    });
});

function event<TType extends string>(type: TType, data: unknown, scope: object = {}): GlobalEvent {
    clock += 1;
    return { createdAt: clock, data, id: `g${clock}`, type, ...scope } as unknown as GlobalEvent;
}

describe("GroupStore holds recent events against their session", () => {
    /** An event id that sorts after every `g<n>` the helper mints. */
    const LATER = "z9";

    it("keeps memory bounded when events name sessions that never load", () => {
        const store = new GroupStore();
        // Far more distinct sessions than the queue is allowed to track, none of
        // which the client will ever be told about.
        for (let index = 0; index < 5_000; index += 1) {
            store.apply(
                event(
                    "session_title_changed",
                    { status: "idle", title: `t${index}` },
                    {
                        sessionId: `ghost-${index}`,
                    },
                ),
            );
        }

        store.applyHello(
            hello({
                cursor: "g0",
                sessions: [
                    { ...session("ghost-4999", "p1"), title: "snapshot" } as SessionSummary,
                    { ...session("ghost-0", "p1"), title: "snapshot" } as SessionSummary,
                ],
            }),
        );
        const titleOf = (id: string) =>
            store
                .projects()
                .flatMap((group) => group.sessions ?? [])
                .find((entry) => entry.id === id)?.title;

        // The newest ghost is still held, so it rebases onto its event.
        expect(titleOf("ghost-4999")).toBe("t4999");
        // The oldest was evicted long ago, which is the whole point of the bound:
        // had every ghost been retained, this would read "t0" instead.
        expect(titleOf("ghost-0")).toBe("snapshot");
    });

    it("keeps only recent events for one very busy session", () => {
        const store = new GroupStore();
        for (let index = 0; index < 1_000; index += 1) {
            store.apply(
                event(
                    "session_title_changed",
                    { status: "idle", title: `t${index}` },
                    {
                        sessionId: "busy",
                    },
                ),
            );
        }

        // The newest event still wins over a snapshot that predates it, which is
        // what trimming the oldest is allowed to cost and no more.
        store.applyHello(
            hello({
                cursor: "g0",
                sessions: [{ ...session("busy", "p1"), title: "snapshot" } as SessionSummary],
            }),
        );
        const listed = store
            .projects()
            .flatMap((group) => group.sessions ?? [])
            .find((entry) => entry.id === "busy");
        expect(listed?.title).toBe("t999");
    });

    it("discards events the snapshot already contains", () => {
        const store = new GroupStore();
        store.apply(
            event(
                "session_title_changed",
                { status: "idle", title: "stale" },
                {
                    sessionId: "s1",
                },
            ),
        );

        // The snapshot was taken after that event, so it must win.
        store.applyHello(
            hello({
                cursor: LATER,
                sessions: [{ ...session("s1", "p1"), title: "snapshot" } as SessionSummary],
            }),
        );
        const listed = store
            .projects()
            .flatMap((group) => group.sessions ?? [])
            .find((entry) => entry.id === "s1");
        expect(listed?.title).toBe("snapshot");
    });
});

describe("GroupStore", () => {
    it("projects daemon identity and the global model catalog from the opening frame", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                catalog: {
                    defaultModelId: "sonnet-5",
                    defaultProviderId: "claude",
                    models: [],
                    providers: [],
                },
                identity: { developmentBuildId: "dev-1", version: "0.0.74" },
            }),
        );

        expect(store.state()).toMatchObject({
            catalog: {
                defaultModelId: "sonnet-5",
                defaultProviderId: "claude",
            },
            identity: { developmentBuildId: "dev-1", version: "0.0.74" },
        });
    });

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
        expect(group).toMatchObject({
            id: "p1",
            kind: "regular",
            name: "p1",
            path: "/work/p1",
            usage: { totalTokens: 0 },
        });
        expect(group?.workspaces[0]).toMatchObject({
            id: "w1",
            name: "w1",
            projectId: "p1",
        });
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

    it("keeps project and workspace usage current from their session summaries", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                sessions: [
                    {
                        ...session("s1", "p1"),
                        sessionTokenCount: { lastContextTokens: 10, totalTokens: 40 },
                    },
                    {
                        ...session("s2", "p1", "w1"),
                        sessionTokenCount: { lastContextTokens: 20, totalTokens: 60 },
                    },
                ],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        expect(store.projects()[0]?.usage.totalTokens).toBe(100);
        expect(store.projects()[0]?.workspaces[0]?.usage.totalTokens).toBe(60);

        store.apply(
            event(
                "session_context_changed",
                {
                    sessionTokenCount: {
                        lastContextTokens: 25,
                        totalTokens: 90,
                    },
                },
                { sessionId: "s2" },
            ),
        );

        expect(store.projects()[0]?.usage.totalTokens).toBe(130);
        expect(store.projects()[0]?.workspaces[0]?.usage.totalTokens).toBe(90);
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

    it("keeps the whole tree and its entities by reference across an identical fresh hello", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [session("s1", "p1", "w1")],
                workspaces: [workspace("w1", "p1")],
            }),
        );
        const before = store.projects();
        const beforeWorkspace = before[0]?.workspaces[0];
        const beforeSession = beforeWorkspace?.sessions[0];

        const deltas = store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [session("s1", "p1", "w1")],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        expect(store.projects()).toBe(before);
        expect(store.projects()[0]?.workspaces[0]).toBe(beforeWorkspace);
        expect(store.projects()[0]?.workspaces[0]?.sessions[0]).toBe(beforeSession);
        expect(deltas).toEqual([]);
    });

    it("keeps workspace failures current without replacing unchanged workspace groups", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [],
                workspaces: [
                    workspace("w1", "p1", { error: "Setup failed.", status: "failed" }),
                    workspace("w2", "p1"),
                ],
            }),
        );
        const initial = store.projects();
        const initialFailed = initial[0]?.workspaces[0];
        const initialReady = initial[0]?.workspaces[1];

        expect(initialFailed?.error).toBe("Setup failed.");

        store.apply(
            event(
                "workspace_created",
                {
                    workspace: workspace("w3", "p1", {
                        error: "Creation failed.",
                        status: "failed",
                    }),
                },
                { projectId: "p1", workspaceId: "w3" },
            ),
        );
        expect(store.projects()[0]?.workspaces[2]?.error).toBe("Creation failed.");

        store.apply(
            event(
                "workspace_updated",
                {
                    workspace: workspace("w1", "p1", {
                        error: "Setup failed differently.",
                        status: "failed",
                        version: 2,
                    }),
                },
                { projectId: "p1", workspaceId: "w1" },
            ),
        );
        const changed = store.projects();
        expect(changed[0]?.workspaces[0]?.error).toBe("Setup failed differently.");
        expect(changed[0]?.workspaces[0]).not.toBe(initialFailed);
        expect(changed[0]?.workspaces[1]).toBe(initialReady);

        store.apply(
            event(
                "workspace_updated",
                { workspace: workspace("w1", "p1", { status: "ready", version: 3 }) },
                { projectId: "p1", workspaceId: "w1" },
            ),
        );
        const cleared = store.projects();
        const clearedWorkspace = cleared[0]?.workspaces[0];
        expect(clearedWorkspace?.error).toBeUndefined();
        expect(cleared[0]?.workspaces[1]).toBe(initialReady);

        const stale = store.apply(
            event(
                "workspace_updated",
                {
                    workspace: workspace("w1", "p1", {
                        error: "Stale failure.",
                        status: "failed",
                        version: 2,
                    }),
                },
                { projectId: "p1", workspaceId: "w1" },
            ),
        );
        expect(stale).toEqual([]);
        expect(store.projects()[0]?.workspaces[0]).toBe(clearedWorkspace);
        expect(store.projects()[0]?.workspaces[0]?.error).toBeUndefined();

        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [],
                workspaces: [
                    workspace("w1", "p1", {
                        error: "Reconnect failed.",
                        status: "failed",
                        version: 4,
                    }),
                    workspace("w2", "p1"),
                    workspace("w3", "p1", {
                        error: "Creation failed.",
                        status: "failed",
                    }),
                ],
            }),
        );
        const rebuilt = store.projects();
        expect(rebuilt[0]?.workspaces[0]?.error).toBe("Reconnect failed.");
        expect(rebuilt[0]?.workspaces[0]).not.toBe(clearedWorkspace);
        expect(rebuilt[0]?.workspaces[1]).toBe(initialReady);
    });

    it("projects shared-session metadata without disturbing unchanged catalog references", () => {
        const store = new GroupStore();
        const shared = {
            activeCapabilitiesDescription: "do nothing beyond reading this session",
            capabilityMemberCount: 0,
            includeFriendMessagesInModel: true,
            memberCount: 2,
            offerableCapabilities: [],
            shareId: "share-1",
            state: "active" as const,
            toolOutput: "summaries" as const,
            toolOutputDescription:
                "Friends see what each tool did, without the output it produced.",
        };
        store.applyHello(
            hello({
                projects: [project("p1"), project("p2")],
                sessions: [{ ...session("s1", "p1"), shared }, session("s2", "p2")],
            }),
        );
        const before = store.projects();
        const sharedSession = before[0]?.sessions[0];

        expect(sharedSession?.shared).toBe(shared);

        store.apply(
            event(
                "session_current",
                {
                    session: {
                        ...session("s1", "p1"),
                        lastEventId: "event-200",
                        shared: { ...shared, memberCount: 3 },
                    },
                },
                { id: "event-200", sessionId: "s1" },
            ),
        );
        const after = store.projects();

        expect(after[0]?.sessions[0]).not.toBe(sharedSession);
        expect(after[0]?.sessions[0]?.shared?.memberCount).toBe(3);
        expect(after[1]).toBe(before[1]);
    });

    it("keeps friend-message unread distinct from an ordinary completed turn", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                sessions: [
                    {
                        ...session("s1", "p1"),
                        trackUnread: true,
                        unread: { reason: "friend_message", since: 10 },
                    },
                ],
            }),
        );

        expect(store.projects()[0]?.unread).toMatchObject({
            attentionCount: 0,
            count: 1,
            reason: "friend_message",
        });
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

        expect(store.projects()[0]?.name).toBe("Newer");
        expect(deltas).toEqual([]);
    });

    it("does not let a stale fresh hello replace a newer streamed entity", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        store.apply(
            event(
                "project_updated",
                { project: project("p1", { name: "Newer", version: 5 }) },
                { projectId: "p1" },
            ),
        );
        const before = store.projects();

        const deltas = store.applyHello(
            hello({ projects: [project("p1", { name: "Older", version: 2 })] }),
        );

        expect(store.projects()).toBe(before);
        expect(store.projects()[0]?.name).toBe("Newer");
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

    it("shows cached branch facts while the first change snapshot loads", () => {
        const store = new GroupStore();
        const opening = hello();
        store.applyHello({
            ...opening,
            projects: opening.projects.map((project) => ({
                ...project,
                git: {
                    ahead: 0,
                    behind: 0,
                    branch: "feature/live-git",
                    detached: false,
                },
            })),
        });

        expect(store.projects()[0]?.branch).toBe("feature/live-git");
        expect(store.projects()[0]?.git).toBeUndefined();
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

    it("opens with existing terminals and follows their live scope state", () => {
        const store = new GroupStore();
        const terminal = {
            cols: 100,
            epoch: "epoch-1",
            exitCode: null,
            id: "terminal-1",
            rows: 30,
            status: "running" as const,
        };
        store.applyHello(
            hello({
                terminalGroups: [{ projectId: "p1", terminals: [terminal] }],
                workspaces: [workspace("w1", "p1")],
            }),
        );
        expect(store.projects()[0]?.terminals).toEqual([terminal]);
        expect(store.projects()[0]?.workspaces[0]?.terminals).toEqual([]);

        store.apply(
            event(
                "remote_terminals_changed",
                { terminals: [{ ...terminal, cols: 120 }] },
                { projectId: "p1", workspaceId: "w1" },
            ),
        );

        expect(store.projects()[0]?.workspaces[0]?.terminals).toMatchObject([
            { cols: 120, id: "terminal-1" },
        ]);
    });

    it("drops terminal projections as soon as their parent is archived", () => {
        const store = new GroupStore();
        const terminal = {
            cols: 100,
            epoch: "epoch-1",
            exitCode: null,
            id: "terminal-1",
            rows: 30,
            status: "running" as const,
        };
        store.applyHello(
            hello({
                terminalGroups: [
                    { projectId: "p1", terminals: [terminal] },
                    { projectId: "p1", terminals: [terminal], workspaceId: "w1" },
                ],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        store.apply(
            event(
                "project_updated",
                { project: project("p1", { archivedAt: 2, version: 2 }) },
                { projectId: "p1" },
            ),
        );

        expect(store.projects()).toEqual([]);
        expect(store.remoteTerminals()).toEqual([]);
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

    it("preserves a session title while metadata refreshes and clears it when settled", () => {
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

        store.apply(event("session_title_changed", { status: "generating" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.sessions[0]?.title).toBe("Ship it");

        store.apply(
            event(
                "session_title_changed",
                { errorMessage: "Could not refresh metadata.", status: "error" },
                { sessionId: "s1" },
            ),
        );
        expect(store.projects()[0]?.sessions[0]?.title).toBe("Ship it");

        store.apply(event("session_title_changed", { status: "idle" }, { sessionId: "s1" }));
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

    it("follows a model switch and a permission mode change", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(
            event(
                "session_configuration_changed",
                {
                    changed: ["modelId", "effort", "serviceTier"],
                    effort: "high",
                    modelId: "opus-5",
                    serviceTier: "priority",
                },
                { sessionId: "s1" },
            ),
        );
        store.apply(
            event(
                "session_draft_changed",
                { draft: "Continue here", updatedAt: 22 },
                { sessionId: "s1" },
            ),
        );
        store.apply(
            event("permission_mode_changed", { permissionMode: "plan" }, { sessionId: "s1" }),
        );

        // A sidebar names the model and the permission mode next to a session,
        // so both have to follow the stream rather than stay at whatever the
        // opening frame said.
        expect(store.projects()[0]?.sessions[0]?.modelId).toBe("opus-5");
        expect(store.projects()[0]?.sessions[0]?.effort).toBe("high");
        expect(store.projects()[0]?.sessions[0]?.serviceTier).toBe("priority");
        expect(store.projects()[0]?.sessions[0]?.draft).toBe("Continue here");
        expect(store.projects()[0]?.sessions[0]?.draftUpdatedAt).toBe(22);
        expect(store.projects()[0]?.sessions[0]?.permissionMode).toBe("plan");
    });

    it("shows a run that failed as an error rather than as idle", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(event("session_status_changed", { status: "error" }, { sessionId: "s1" }));

        expect(store.projects()[0]?.sessions[0]?.status).toBe("error");
    });

    it("follows the recap alongside the title, including clearing it", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(
            event(
                "session_title_changed",
                { recap: "Fixed the parser", status: "ready", title: "Parser" },
                { sessionId: "s1" },
            ),
        );
        expect(store.projects()[0]?.sessions[0]?.recap).toBe("Fixed the parser");

        store.apply(event("session_title_changed", { status: "generating" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.sessions[0]?.recap).toBe("Fixed the parser");

        // The recap rides on the same event as the title and is cleared the same
        // way when metadata settles. A store that only read the title would leave
        // a stale summary under a renamed session.
        store.apply(
            event(
                "session_title_changed",
                { status: "ready", title: "Parser" },
                { sessionId: "s1" },
            ),
        );
        expect(store.projects()[0]?.sessions[0]?.recap).toBeUndefined();
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

describe("GroupStore and chats waiting for the person", () => {
    /** A tracked chat: the daemon only keeps unread state when asked to. */
    function tracked(id: string, projectId: string, workspaceId?: string): SessionSummary {
        return { ...session(id, projectId, workspaceId), trackUnread: true };
    }

    it("marks a chat unread when its turn ends, and reads the reason from the event", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [tracked("s1", "p1")] }));
        expect(store.projects()[0]?.sessions[0]?.unread).toBeUndefined();

        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s1" }));

        expect(store.projects()[0]?.sessions[0]?.unread).toMatchObject({
            reason: "turn_finished",
        });
        expect(store.projects()[0]?.unread).toMatchObject({ attentionCount: 0, count: 1 });
    });

    it("says a chat needs the person when it asks something", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [tracked("s1", "p1")] }));

        store.apply(event("user_input_requested", { requestId: "q1" }, { sessionId: "s1" }));
        // The run ending afterwards does not answer the question.
        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s1" }));

        expect(store.projects()[0]?.unread).toMatchObject({
            attentionCount: 1,
            count: 1,
            reason: "attention_needed",
        });
    });

    it("leaves an untracked chat read, so a subagent finishing says nothing", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s1" }));

        expect(store.projects()[0]?.sessions[0]?.unread).toBeUndefined();
        expect(store.projects()[0]?.unread).toEqual({ attentionCount: 0, count: 0 });
    });

    it("counts a worktree's waiting chats on the worktree, never on the project", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                projects: [project("p1")],
                sessions: [tracked("s1", "p1"), tracked("s2", "p1", "w1")],
                workspaces: [workspace("w1", "p1")],
            }),
        );

        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s2" }));

        const group = store.projects()[0];
        // The chat waiting is inside the worktree, and that is where the person
        // has to go to answer it, so the project itself is still caught up.
        expect(group?.workspaces[0]?.unread).toMatchObject({ count: 1 });
        expect(group?.unread).toEqual({ attentionCount: 0, count: 0 });

        store.apply(event("run_finished", { runId: "r2" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.unread).toMatchObject({ count: 1 });
        expect(store.projects()[0]?.workspaces[0]?.unread).toMatchObject({ count: 1 });
    });

    it("reports the longest wait and the strongest reason across a group", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [tracked("s1", "p1"), tracked("s2", "p1")] }));

        const first = event("run_finished", { runId: "r1" }, { sessionId: "s1" });
        store.apply(first);
        store.apply(event("user_input_requested", { requestId: "q1" }, { sessionId: "s2" }));

        expect(store.projects()[0]?.unread).toEqual({
            attentionCount: 1,
            count: 2,
            reason: "attention_needed",
            since: first.createdAt,
        });
    });

    it("clears unread when the daemon says the chat was caught up on", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [tracked("s1", "p1")] }));
        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.unread.count).toBe(1);

        // A read chat is reported by leaving `unread` out entirely, so the
        // omission has to clear it rather than merge as no change.
        store.apply(
            event("session_updated", { session: tracked("s1", "p1") }, { sessionId: "s1" }),
        );

        expect(store.projects()[0]?.sessions[0]?.unread).toBeUndefined();
        expect(store.projects()[0]?.unread).toEqual({ attentionCount: 0, count: 0 });
    });

    it("predicts a chat being read, and puts it back if the daemon refuses", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [tracked("s1", "p1")] }));
        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s1" }));

        const changed = store.applyOptimisticSessionRead("s1");
        expect(store.projects()[0]?.unread.count).toBe(0);

        changed.undo();
        expect(store.projects()[0]?.unread.count).toBe(1);
        // Predicting it twice is not an error; the second is simply nothing.
        store.applyOptimisticSessionRead("s1");
        expect(store.applyOptimisticSessionRead("s1").deltas).toEqual([]);
    });

    it("leaves an archived chat out of the count", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [tracked("s1", "p1")] }));
        store.apply(event("run_finished", { runId: "r1" }, { sessionId: "s1" }));
        expect(store.projects()[0]?.unread.count).toBe(1);

        store.apply(event("session_archived", { archived: true }, { sessionId: "s1" }));

        expect(store.projects()[0]?.unread).toEqual({ attentionCount: 0, count: 0 });
    });
});

describe("GroupStore and where the user is", () => {
    const away = {
        presence: {
            answerWaitMs: 0,
            emoji: "🌙",
            id: "away",
            prompt: "The user is away and cannot be reached.",
            title: "Away",
        },
        presences: [
            {
                answerWaitMs: null,
                emoji: "🟢",
                id: "online",
                prompt: "The user is at the keyboard.",
                title: "Online",
            },
            {
                answerWaitMs: 0,
                emoji: "🌙",
                id: "away",
                prompt: "The user is away and cannot be reached.",
                title: "Away",
            },
        ],
        since: 5,
    };

    it("reads presence from the opening frame and follows it as it changes", () => {
        const store = new GroupStore();
        store.applyHello(hello());
        expect(store.state().presence?.presence.id).toBe("online");

        const deltas = store.apply(event("presence_changed", { presence: away }));

        expect(deltas.map((delta) => delta.type)).toContain("groups_state_changed");
        expect(store.state().presence).toEqual(away);
    });

    it("ignores a presence change that says what it already knows", () => {
        const store = new GroupStore();
        store.applyHello(hello({ presence: away }));
        const before = store.state();

        expect(store.apply(event("presence_changed", { presence: { ...away } }))).toEqual([]);
        expect(store.state()).toBe(before);
    });
});

describe("GroupStore and scheduled waits", () => {
    const waitingActivity = {
        kind: "waiting",
        label: "Waiting until later",
        since: 100,
        wait: { dueAt: 900, startedAt: 100, toolCallId: "call-wait" },
    };

    it("shows the wait when the live stream says the agent started one", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));

        const deltas = store.apply(
            event("session_activity_changed", { activity: waitingActivity }, { sessionId: "s1" }),
        );

        expect(deltas.map((delta) => delta.type)).toContain("projects_changed");
        expect(store.projects()[0]?.sessions[0]?.wait).toEqual({ dueAt: 900, startedAt: 100 });
    });

    it("clears the wait when the agent moves on to other work", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));
        store.apply(
            event("session_activity_changed", { activity: waitingActivity }, { sessionId: "s1" }),
        );

        const deltas = store.apply(
            event(
                "session_activity_changed",
                { activity: { kind: "thinking", label: "Thinking", since: 950 } },
                { sessionId: "s1" },
            ),
        );

        expect(deltas.map((delta) => delta.type)).toContain("projects_changed");
        expect(store.projects()[0]?.sessions[0]?.wait).toBeUndefined();
    });

    it("seeds the wait from the opening frame for a client connecting mid-wait", () => {
        const store = new GroupStore();
        store.applyHello(
            hello({
                sessions: [
                    {
                        ...session("s1", "p1"),
                        wait: { dueAt: 900, startedAt: 100, toolCallId: "call-wait" },
                    },
                ],
            }),
        );

        expect(store.projects()[0]?.sessions[0]?.wait).toEqual({ dueAt: 900, startedAt: 100 });
    });

    it("ignores activity changes that leave the wait as it stands", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));
        const before = store.projects();

        // A working agent changes activity on every step; only the wait is
        // catalog state, so everything else must not rebuild the tree.
        const deltas = store.apply(
            event(
                "session_activity_changed",
                { activity: { kind: "thinking", label: "Thinking", since: 10 } },
                { sessionId: "s1" },
            ),
        );

        expect(deltas).toEqual([]);
        expect(store.projects()).toBe(before);

        store.apply(
            event("session_activity_changed", { activity: waitingActivity }, { sessionId: "s1" }),
        );
        const whileWaiting = store.projects();
        const repeat = store.apply(
            event(
                "session_activity_changed",
                { activity: { ...waitingActivity, label: "Still waiting", since: 200 } },
                { sessionId: "s1" },
            ),
        );
        expect(repeat).toEqual([]);
        expect(store.projects()).toBe(whileWaiting);
    });

    it("survives a fresh hello taken while the wait is still running", () => {
        const store = new GroupStore();
        store.applyHello(hello({ sessions: [session("s1", "p1")] }));
        store.apply(
            event("session_activity_changed", { activity: waitingActivity }, { sessionId: "s1" }),
        );

        // A reconnect snapshot taken mid-wait carries the wait itself, so the
        // catalog keeps showing it rather than blanking until the next event.
        store.applyHello(
            hello({
                cursor: "z9",
                sessions: [
                    {
                        ...session("s1", "p1"),
                        wait: { dueAt: 900, startedAt: 100, toolCallId: "call-wait" },
                    },
                ],
            }),
        );

        expect(store.projects()[0]?.sessions[0]?.wait).toEqual({ dueAt: 900, startedAt: 100 });
    });
});
