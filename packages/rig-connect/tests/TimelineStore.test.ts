import { describe, expect, it } from "vitest";

// The daemon's own fold, imported so this library's live application can be
// compared against it directly. It is a test-only import; nothing from the
// daemon reaches the bundle.
import { buildTimeline } from "../../rig/sources/timeline/buildTimeline.js";
import type { TimelineAgentSource } from "../../rig/sources/timeline/TimelineSource.js";
import type { SessionEvent as DaemonSessionEvent } from "../../rig/sources/protocol/index.js";
import { TimelineStore } from "@/TimelineStore.js";
import type { GetTimelineResponse, GlobalEvent, TimelineAgent } from "@/protocol.js";

const MINUTE = 60_000;

describe("TimelineStore", () => {
    it("nests each agent under the agent that started it", () => {
        const store = new TimelineStore({ kind: "session", sessionId: "root" });

        store.applySnapshot(
            snapshot([
                agent({ sessionId: "root" }),
                agent({ depth: 1, parentSessionId: "root", sessionId: "child", type: "subagent" }),
                agent({
                    depth: 2,
                    parentSessionId: "child",
                    sessionId: "grandchild",
                    type: "subagent",
                }),
            ]),
        );

        const agents = store.agents();
        expect(agents).toHaveLength(1);
        expect(agents[0]!.sessionId).toBe("root");
        expect(agents[0]!.children[0]!.sessionId).toBe("child");
        expect(agents[0]!.children[0]!.children[0]!.sessionId).toBe("grandchild");
    });

    it("draws an agent whose parent is outside the chart at the top level", () => {
        const store = new TimelineStore({ kind: "session", sessionId: "child" });

        store.applySnapshot(
            snapshot([
                agent({ depth: 1, parentSessionId: "root", sessionId: "child", type: "subagent" }),
            ]),
        );

        expect(store.agents().map((node) => node.sessionId)).toEqual(["child"]);
    });

    it("reports the span of time the whole chart covers", () => {
        const store = new TimelineStore({ kind: "project", projectId: "p1" });

        store.applySnapshot(
            snapshot([
                agent({
                    sessionId: "a",
                    spans: [
                        {
                            endedAt: 2 * MINUTE,
                            kind: "working",
                            outcome: "completed",
                            startedAt: 0,
                        },
                    ],
                }),
                agent({
                    sessionId: "b",
                    spans: [
                        {
                            endedAt: 9 * MINUTE,
                            kind: "working",
                            outcome: "completed",
                            startedAt: 5 * MINUTE,
                        },
                    ],
                }),
            ]),
        );

        expect(store.state()).toMatchObject({ from: 0, to: 9 * MINUTE });
    });

    it("leaves the chart's end open while any agent is still going", () => {
        const store = new TimelineStore({ kind: "project", projectId: "p1" });

        store.applySnapshot(
            snapshot([agent({ sessionId: "a", spans: [{ kind: "working", startedAt: MINUTE }] })]),
        );

        expect(store.state().to).toBeUndefined();
    });

    it("opens and closes a run's bar as the stream reports it", () => {
        const store = new TimelineStore({ kind: "session", sessionId: "s" });
        store.applySnapshot(
            snapshot([agent({ sessionId: "s", spans: [{ kind: "waiting", startedAt: 0 }] })]),
        );

        const started = store.apply(event("run_started", MINUTE, { runId: "run-1" }));
        const finished = store.apply(
            event("run_finished", 4 * MINUTE, { runId: "run-1", stopReason: "stop" }),
        );

        expect(started.map((delta) => delta.type)).toContain("span_started");
        expect(finished.map((delta) => delta.type)).toContain("span_ended");
        expect(store.agents()[0]!.spans).toEqual([
            { endedAt: MINUTE, kind: "waiting", outcome: "completed", startedAt: 0 },
            {
                endedAt: 4 * MINUTE,
                kind: "working",
                outcome: "completed",
                runId: "run-1",
                startedAt: MINUTE,
            },
            { kind: "waiting", startedAt: 4 * MINUTE },
        ]);
    });

    it("closes an asking span when presence lets the agent continue", () => {
        const store = new TimelineStore({ kind: "session", sessionId: "s" });
        store.applySnapshot(snapshot([agent({ sessionId: "s" })]));
        store.apply(event("user_input_requested", MINUTE, { questions: [], requestId: "ask-1" }));

        const deltas = store.apply(
            event("user_input_detached", 2 * MINUTE, {
                presenceId: "away",
                reason: "away",
                requestId: "ask-1",
            }),
        );

        expect(deltas).toContainEqual({
            kind: "asking",
            sessionId: "s",
            type: "span_ended",
        });
        expect(store.agents()[0]!.spans).toEqual([
            {
                endedAt: 2 * MINUTE,
                kind: "asking",
                outcome: "cancelled",
                requestId: "ask-1",
                startedAt: MINUTE,
            },
        ]);
    });

    it("adds a chat that appears while the chart is open", () => {
        const store = new TimelineStore({ kind: "project", projectId: "p1" });
        store.applySnapshot(snapshot([]));

        const deltas = store.apply(
            event("session_created", MINUTE, {
                session: {
                    agent: { depth: 0, rootSessionId: "new", type: "primary" },
                    agentId: "agent-new",
                    id: "new",
                    modelId: "model",
                    projectId: "p1",
                    providerId: "codex",
                    title: "Fix the parser",
                },
            }),
        );

        expect(deltas.map((delta) => delta.type)).toContain("agent_added");
        expect(store.agents()[0]).toMatchObject({ label: "Fix the parser", sessionId: "new" });
    });

    it("adopts a chat from any project into a global chart", () => {
        const store = new TimelineStore({ kind: "global" });
        store.applySnapshot({
            agents: [],
            cursor: "01900000-0000-7000-8000-000000000001",
            scope: { kind: "global" },
        });

        store.apply(
            event("session_created", MINUTE, {
                session: {
                    agentId: "agent-far",
                    id: "far",
                    modelId: "model",
                    // A project this chart was never told about; global means global.
                    projectId: "some-other-project",
                    providerId: "codex",
                },
            }),
        );

        expect(store.agents().map((node) => node.sessionId)).toEqual(["far"]);
    });

    it("ignores a chat created outside the chart's scope", () => {
        const store = new TimelineStore({ kind: "project", projectId: "p1" });
        store.applySnapshot(snapshot([]));

        store.apply(
            event("session_created", MINUTE, {
                session: {
                    agentId: "agent-other",
                    id: "other",
                    modelId: "model",
                    projectId: "p2",
                    providerId: "codex",
                },
            }),
        );

        expect(store.agents()).toEqual([]);
    });

    it("keeps the identity of every row that did not change", () => {
        const store = new TimelineStore({ kind: "project", projectId: "p1" });
        store.applySnapshot(
            snapshot([
                agent({ sessionId: "a", spans: [{ kind: "waiting", startedAt: 0 }] }),
                agent({ sessionId: "b", spans: [{ kind: "waiting", startedAt: 0 }] }),
            ]),
        );
        const before = store.agents();

        store.apply(event("run_started", MINUTE, { runId: "run-1" }, "a"));
        const after = store.agents();

        expect(after[0]).not.toBe(before[0]);
        expect(after[1]).toBe(before[1]);
    });

    it("rebuilds a parent row when one of its children changes", () => {
        const store = new TimelineStore({ kind: "session", sessionId: "root" });
        store.applySnapshot(
            snapshot([
                agent({ sessionId: "root", spans: [{ kind: "waiting", startedAt: 0 }] }),
                agent({
                    depth: 1,
                    parentSessionId: "root",
                    sessionId: "child",
                    spans: [{ kind: "waiting", startedAt: 0 }],
                    type: "subagent",
                }),
            ]),
        );
        const before = store.agents();

        store.apply(event("run_started", MINUTE, { runId: "run-1" }, "child"));

        expect(store.agents()[0]).not.toBe(before[0]);
        expect(store.agents()[0]!.children[0]!.spans).toHaveLength(2);
    });

    it("arrives at the same chart the daemon would have folded", () => {
        // The daemon folds durable history at load; this library folds the live
        // stream. They must agree, or a chart would change the moment it is
        // reloaded.
        const events = [
            lifecycle("message_submitted", MINUTE, { runId: "run-1" }),
            lifecycle("run_started", MINUTE, { runId: "run-1" }),
            lifecycle("user_input_requested", 2 * MINUTE, { questions: [], requestId: "ask-1" }),
            lifecycle("user_input_resolved", 3 * MINUTE, {
                requestId: "ask-1",
                status: "answered",
            }),
            lifecycle("user_input_requested", 3 * MINUTE, {
                questions: [],
                requestId: "ask-2",
            }),
            lifecycle("user_input_detached", 3.5 * MINUTE, {
                presenceId: "away",
                reason: "away",
                requestId: "ask-2",
            }),
            lifecycle("run_finished", 4 * MINUTE, { runId: "run-1", stopReason: "stop" }),
            lifecycle("message_submitted", 9 * MINUTE, { runId: "run-2" }),
            lifecycle("run_started", 9 * MINUTE, { runId: "run-2" }),
            lifecycle("run_error", 11 * MINUTE, { runId: "run-2" }),
        ];
        const source: TimelineAgentSource = {
            agentId: "agent-1",
            archived: false,
            createdAt: 0,
            depth: 0,
            modelId: "model",
            projectId: "p1",
            providerId: "codex",
            sessionId: "s",
            type: "primary",
            working: false,
        };

        const store = new TimelineStore({ kind: "session", sessionId: "s" });
        store.applySnapshot(
            snapshot([agent({ sessionId: "s", spans: [{ kind: "waiting", startedAt: 0 }] })]),
        );
        for (const durable of events) store.apply(durable as unknown as GlobalEvent);

        const folded = buildTimeline([source], events as unknown as DaemonSessionEvent[]);
        expect(store.agents()[0]!.spans).toEqual(folded[0]!.spans);
    });
});

function snapshot(agents: readonly TimelineAgent[]): GetTimelineResponse {
    return {
        agents,
        cursor: "01900000-0000-7000-8000-000000000001",
        scope: agents[0] === undefined ? { kind: "project", projectId: "p1" } : scopeFor(agents[0]),
    };
}

function scopeFor(agent: TimelineAgent): GetTimelineResponse["scope"] {
    return { kind: "project", projectId: agent.projectId };
}

function agent(overrides: Partial<TimelineAgent> & { sessionId: string }): TimelineAgent {
    return {
        agentId: `agent-${overrides.sessionId}`,
        createdAt: 0,
        depth: 0,
        label: "Untitled chat",
        modelId: "model",
        projectId: "p1",
        providerId: "codex",
        spans: [],
        type: "primary",
        ...overrides,
    };
}

function event(type: string, createdAt: number, data: unknown, sessionId = "s"): GlobalEvent {
    return {
        createdAt,
        data,
        id: `${type}-${String(createdAt)}`,
        projectId: "p1",
        sessionId,
        type,
    } as unknown as GlobalEvent;
}

function lifecycle(type: string, createdAt: number, data: unknown): GlobalEvent {
    return event(type, createdAt, data, "s");
}
