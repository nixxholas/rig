import type { TimelineAgentNode, TimelineDelta, TimelineState } from "./TimelineElement.js";
import type {
    GetTimelineResponse,
    GlobalEvent,
    ProtocolSession,
    TimelineAgent,
    TimelineScope,
    TimelineSpan,
    TimelineSpanOutcome,
} from "./protocol.js";

interface AgentRecord {
    agent: TimelineAgent;
    asking: Map<string, TimelineSpan>;
    spans: TimelineSpan[];
    waiting?: TimelineSpan | undefined;
    working?: TimelineSpan | undefined;
}

/**
 * Keeps one timeline current from the global event stream.
 *
 * The daemon folds durable history into spans once, at load. From then on the
 * same rules run here against the live stream, so the chart moves as work does
 * instead of waiting on another round trip. A reload produces the identical
 * chart a client watched being built.
 */
export class TimelineStore {
    #agents = new Map<string, AgentRecord>();
    #nodes = new Map<string, TimelineAgentNode>();
    #order: string[] = [];
    #scope: TimelineScope;
    #state: TimelineState;
    #tree: readonly TimelineAgentNode[] = [];
    #treeStale = true;

    constructor(scope: TimelineScope) {
        this.#scope = scope;
        this.#state = { connection: "connecting", scope };
    }

    agents(): readonly TimelineAgentNode[] {
        if (this.#treeStale) this.#rebuild();
        return this.#tree;
    }

    state(): TimelineState {
        if (this.#treeStale) this.#rebuild();
        return this.#state;
    }

    setConnection(connection: TimelineState["connection"]): TimelineDelta[] {
        if (this.#state.connection === connection) return [];
        this.#state = { ...this.#state, connection };
        return [{ state: this.#state, type: "timeline_state_changed" }];
    }

    /** Replaces the chart with the daemon's own fold of durable history. */
    applySnapshot(snapshot: GetTimelineResponse): TimelineDelta[] {
        this.#scope = snapshot.scope;
        this.#agents = new Map(
            snapshot.agents.map((agent) => [agent.sessionId, recordFor(agent)] as const),
        );
        this.#order = snapshot.agents.map((agent) => agent.sessionId);
        this.#nodes.clear();
        this.#treeStale = true;
        this.#state = { ...this.#state, scope: snapshot.scope };
        const agents = this.agents();
        return [
            { agents, type: "timeline_changed" },
            { state: this.#state, type: "timeline_state_changed" },
        ];
    }

    apply(event: GlobalEvent): TimelineDelta[] {
        if (event.type === "session_created") {
            const created = (event.data as { session: ProtocolSession }).session;
            return this.#publish(this.#addAgent(created, event.createdAt));
        }
        if (!("sessionId" in event) || typeof event.sessionId !== "string") return [];
        const record = this.#agents.get(event.sessionId);
        if (record === undefined) return [];
        const deltas = this.#applyLifecycle(record, event);
        if (deltas.length === 0) return [];
        this.#nodes.delete(event.sessionId);
        this.#treeStale = true;
        return this.#publish(deltas);
    }

    /** Follows a change with the redrawn chart, and with new bounds if they moved. */
    #publish(deltas: readonly TimelineDelta[]): TimelineDelta[] {
        if (deltas.length === 0) return [];
        const state = this.#state;
        const agents = this.agents();
        return [
            ...deltas,
            { agents, type: "timeline_changed" },
            ...(this.#state === state
                ? []
                : ([{ state: this.#state, type: "timeline_state_changed" }] as const)),
        ];
    }

    #applyLifecycle(record: AgentRecord, event: GlobalEvent): TimelineDelta[] {
        const sessionId = record.agent.sessionId;
        const at = event.createdAt;
        if (event.type === "message_submitted") {
            if (record.waiting === undefined) return [];
            const closed = close(record, record.waiting, at, "completed");
            record.waiting = undefined;
            return closed ? [{ kind: "waiting", sessionId, type: "span_ended" }] : [];
        }
        if (event.type === "run_started") {
            const deltas: TimelineDelta[] = [];
            if (record.working !== undefined) {
                close(record, record.working, at, "interrupted");
                deltas.push({ kind: "working", sessionId, type: "span_ended" });
            }
            if (record.waiting !== undefined) {
                if (close(record, record.waiting, at, "completed")) {
                    deltas.push({ kind: "waiting", sessionId, type: "span_ended" });
                }
                record.waiting = undefined;
            }
            record.working = { kind: "working", runId: runIdOf(event), startedAt: at };
            record.spans.push(record.working);
            deltas.push({ kind: "working", sessionId, type: "span_started" });
            return deltas;
        }
        if (event.type === "run_finished" || event.type === "run_error") {
            if (record.working === undefined) {
                record.working = { kind: "working", runId: runIdOf(event), startedAt: at };
                record.spans.push(record.working);
            }
            close(record, record.working, at, terminalOutcome(event));
            record.working = undefined;
            record.waiting = { kind: "waiting", startedAt: at };
            record.spans.push(record.waiting);
            return [
                { kind: "working", sessionId, type: "span_ended" },
                { kind: "waiting", sessionId, type: "span_started" },
            ];
        }
        if (event.type === "user_input_requested") {
            const requestId = (event.data as { requestId: string }).requestId;
            if (record.asking.has(requestId)) return [];
            const span: TimelineSpan = { kind: "asking", requestId, startedAt: at };
            record.asking.set(requestId, span);
            record.spans.push(span);
            return [{ kind: "asking", sessionId, type: "span_started" }];
        }
        if (event.type === "user_input_resolved") {
            const resolution = event.data as { requestId: string; status: string };
            const span = record.asking.get(resolution.requestId);
            if (span === undefined) return [];
            close(record, span, at, resolution.status === "answered" ? "answered" : "cancelled");
            record.asking.delete(resolution.requestId);
            return [{ kind: "asking", sessionId, type: "span_ended" }];
        }
        return [];
    }

    #addAgent(session: ProtocolSession, createdAt: number): TimelineDelta[] {
        if (this.#agents.has(session.id) || !this.#inScope(session)) return [];
        const record = recordFor(agentFromSession(session, createdAt));
        // A brand new chat has done nothing yet, so it starts out waiting for
        // whoever opened it.
        record.waiting = { kind: "waiting", startedAt: createdAt };
        record.spans.push(record.waiting);
        this.#agents.set(session.id, record);
        this.#order.push(session.id);
        this.#treeStale = true;
        return [{ sessionId: session.id, type: "agent_added" }];
    }

    #inScope(session: ProtocolSession): boolean {
        if (this.#scope.kind === "project") return session.projectId === this.#scope.projectId;
        if (this.#scope.kind === "workspace") {
            return session.workspaceId === this.#scope.workspaceId;
        }
        if (session.id === this.#scope.sessionId) return true;
        // A subagent belongs to the chart whenever one of its ancestors does.
        let parentId = session.agent?.parentSessionId;
        while (parentId !== undefined) {
            if (parentId === this.#scope.sessionId) return true;
            parentId = this.#agents.get(parentId)?.agent.parentSessionId;
        }
        return false;
    }

    #rebuild(): void {
        const nodes = new Map<string, TimelineAgentNode>();
        const children = new Map<string, string[]>();
        const roots: string[] = [];
        const ordered = [...this.#order].sort(
            (left, right) =>
                (this.#agents.get(left)?.agent.createdAt ?? 0) -
                (this.#agents.get(right)?.agent.createdAt ?? 0),
        );
        for (const sessionId of ordered) {
            const record = this.#agents.get(sessionId);
            if (record === undefined) continue;
            const parentId = record.agent.parentSessionId;
            // An agent whose parent is outside the chart is drawn at the top
            // level rather than hidden with it.
            if (parentId === undefined || !this.#agents.has(parentId)) roots.push(sessionId);
            else children.set(parentId, [...(children.get(parentId) ?? []), sessionId]);
        }
        const build = (sessionId: string): TimelineAgentNode | undefined => {
            const record = this.#agents.get(sessionId);
            if (record === undefined) return undefined;
            const built = (children.get(sessionId) ?? []).flatMap((childId) => {
                const child = build(childId);
                return child === undefined ? [] : [child];
            });
            const cached = this.#nodes.get(sessionId);
            if (cached !== undefined && sameChildren(cached.children, built)) return cached;
            const node = nodeFor(record, built);
            nodes.set(sessionId, node);
            return node;
        };
        const tree = roots.flatMap((sessionId) => {
            const node = build(sessionId);
            return node === undefined ? [] : [node];
        });
        for (const [sessionId, node] of nodes) this.#nodes.set(sessionId, node);
        for (const sessionId of [...this.#nodes.keys()]) {
            if (!this.#agents.has(sessionId)) this.#nodes.delete(sessionId);
        }
        this.#tree = tree;
        this.#treeStale = false;
        this.#state = boundsOf(this.#state, [...this.#agents.values()]);
    }
}

function recordFor(agent: TimelineAgent): AgentRecord {
    const spans = agent.spans.map((span) => ({ ...span }));
    const record: AgentRecord = { agent: { ...agent, spans: [] }, asking: new Map(), spans };
    // The daemon leaves a span open exactly when the work behind it is still
    // going, so reopening it here is how the live fold picks up where the
    // snapshot left off.
    for (const span of spans) {
        if (span.endedAt !== undefined) continue;
        if (span.kind === "waiting") record.waiting = span;
        else if (span.kind === "working") record.working = span;
        else if (span.requestId !== undefined) record.asking.set(span.requestId, span);
    }
    return record;
}

function agentFromSession(session: ProtocolSession, createdAt: number): TimelineAgent {
    const agent = session.agent;
    const label = session.title ?? agent?.taskName ?? agent?.description;
    return {
        agentId: session.agentId ?? session.id,
        createdAt,
        depth: agent?.depth ?? 0,
        label:
            label !== undefined && label.trim().length > 0
                ? label.trim()
                : agent?.type === "subagent"
                  ? "Delegated task"
                  : "Untitled chat",
        modelId: session.modelId,
        projectId: session.projectId,
        providerId: session.providerId,
        sessionId: session.id,
        spans: [],
        type: agent?.type ?? "primary",
        ...(agent?.parentSessionId === undefined ? {} : { parentSessionId: agent.parentSessionId }),
        ...(agent?.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: agent.parentToolCallId }),
        ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    };
}

function nodeFor(record: AgentRecord, children: readonly TimelineAgentNode[]): TimelineAgentNode {
    const spans = record.spans.map((span) => ({ ...span }));
    const starts = spans.map((span) => span.startedAt);
    const open = spans.some((span) => span.endedAt === undefined);
    const ends = spans.flatMap((span) => (span.endedAt === undefined ? [] : [span.endedAt]));
    const childEnd = children.every((child) => child.endedAt !== undefined)
        ? children.map((child) => child.endedAt ?? 0)
        : undefined;
    const endedAt = open || childEnd === undefined ? undefined : Math.max(...ends, ...childEnd, 0);
    return {
        agentId: record.agent.agentId,
        children,
        createdAt: record.agent.createdAt,
        depth: record.agent.depth,
        label: record.agent.label,
        modelId: record.agent.modelId,
        projectId: record.agent.projectId,
        providerId: record.agent.providerId,
        sessionId: record.agent.sessionId,
        spans,
        startedAt: starts.length === 0 ? record.agent.createdAt : Math.min(...starts),
        type: record.agent.type,
        ...(endedAt === undefined || ends.length === 0 ? {} : { endedAt }),
        ...(record.agent.parentSessionId === undefined
            ? {}
            : { parentSessionId: record.agent.parentSessionId }),
        ...(record.agent.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: record.agent.parentToolCallId }),
        ...(record.agent.workspaceId === undefined
            ? {}
            : { workspaceId: record.agent.workspaceId }),
    };
}

function boundsOf(state: TimelineState, records: readonly AgentRecord[]): TimelineState {
    const spans = records.flatMap((record) => record.spans);
    const from = spans.length === 0 ? undefined : Math.min(...spans.map((span) => span.startedAt));
    const open = spans.some((span) => span.endedAt === undefined);
    const ends = spans.flatMap((span) => (span.endedAt === undefined ? [] : [span.endedAt]));
    const to = open || ends.length === 0 ? undefined : Math.max(...ends);
    const next: TimelineState = {
        connection: state.connection,
        scope: state.scope,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
    };
    return next.from === state.from && next.to === state.to ? state : next;
}

function runIdOf(event: GlobalEvent): string {
    return (event.data as { runId: string }).runId;
}

function close(
    record: AgentRecord,
    span: TimelineSpan,
    endedAt: number,
    outcome: TimelineSpanOutcome,
): boolean {
    span.endedAt = Math.max(endedAt, span.startedAt);
    span.outcome = outcome;
    // Waiting is inferred rather than recorded, so a stretch of it nobody spent
    // waiting through never becomes a bar. The daemon's fold drops it too.
    if (span.kind === "waiting" && span.endedAt === span.startedAt) {
        record.spans = record.spans.filter((candidate) => candidate !== span);
        return false;
    }
    return true;
}

function terminalOutcome(event: GlobalEvent): TimelineSpanOutcome {
    if (event.type === "run_error") return "error";
    if (event.type !== "run_finished") return "completed";
    const stopReason = (event.data as { stopReason?: string }).stopReason;
    if (stopReason === "aborted") return "aborted";
    if (stopReason === "error") return "error";
    return "completed";
}

function sameChildren(
    left: readonly TimelineAgentNode[],
    right: readonly TimelineAgentNode[],
): boolean {
    return left.length === right.length && left.every((node, index) => node === right[index]);
}
