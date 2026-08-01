import type {
    AgentTreeRelation,
    AgentTreeUsage,
    AgentTreeUsageSession,
} from "../agent/context/AgentTreeUsageContext.js";
import { MAX_AGENT_TREE_USAGE_SESSIONS } from "../agent/context/AgentTreeUsageContext.js";
import type { SessionSummary } from "../protocol/index.js";
import type { InMemorySession } from "./InMemorySession.js";

/**
 * Reads a bounded subtree from the live session registry used by InMemorySessionStore.
 *
 * The store does not persist sessions in its project database, so its truthful source is the
 * session objects themselves. This builds each edge index once and never loads a transcript.
 */
export function queryLiveAgentTreeUsage(
    liveSessions: Iterable<InMemorySession>,
    rootSessionId: string,
): AgentTreeUsage | undefined {
    const sessionsById = new Map<string, InMemorySession>();
    const childrenByParent = new Map<string, InMemorySession[]>();
    for (const session of liveSessions) {
        sessionsById.set(session.id, session);
        const metadata = session.agentMetadata();
        if (metadata.parentSessionId !== undefined) {
            addChild(childrenByParent, metadata.parentSessionId, session);
        }
        if (metadata.delegatedBySessionId !== undefined) {
            addChild(childrenByParent, metadata.delegatedBySessionId, session);
        }
    }

    const root = sessionsById.get(rootSessionId);
    if (root === undefined) return undefined;

    const descendants: InMemorySession[] = [];
    const visited = new Set<string>();
    const pending = [root];
    for (let next = 0; next < pending.length; next += 1) {
        const session = pending[next]!;
        if (visited.has(session.id)) continue;
        visited.add(session.id);
        descendants.push(session);
        if (descendants.length > MAX_AGENT_TREE_USAGE_SESSIONS) {
            throw new Error(
                `Agent tree usage is limited to ${MAX_AGENT_TREE_USAGE_SESSIONS.toLocaleString("en-US")} sessions.`,
            );
        }
        pending.push(...(childrenByParent.get(session.id) ?? []));
    }

    const summarized = descendants.map((session) => ({ session, summary: session.summary() }));
    summarized.sort(
        (left, right) =>
            Number(right.session.id === rootSessionId) -
                Number(left.session.id === rootSessionId) ||
            left.summary.createdAt - right.summary.createdAt ||
            left.session.id.localeCompare(right.session.id),
    );
    const returnedIds = new Set(summarized.map(({ session }) => session.id));
    const usageSessions = summarized.map(({ session, summary }) =>
        usageSession(session, summary, rootSessionId, returnedIds),
    );
    return {
        sessions: usageSessions,
        totalTokens: usageSessions.reduce((total, session) => total + session.totalTokens, 0),
    };
}

function addChild(
    childrenByParent: Map<string, InMemorySession[]>,
    parentSessionId: string,
    session: InMemorySession,
): void {
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(parentSessionId, children);
}

function usageSession(
    session: InMemorySession,
    summary: SessionSummary,
    rootSessionId: string,
    returnedIds: ReadonlySet<string>,
): AgentTreeUsageSession {
    const metadata = session.agentMetadata();
    if (metadata.parentSessionId !== undefined && metadata.delegatedBySessionId !== undefined) {
        throw new Error(`Session '${session.id}' has both subagent and delegation parents.`);
    }
    const relation: AgentTreeRelation =
        session.id === rootSessionId
            ? "root"
            : metadata.parentSessionId !== undefined
              ? "subagent"
              : "delegated";
    const parentSessionId =
        relation === "subagent"
            ? metadata.parentSessionId
            : relation === "delegated"
              ? metadata.delegatedBySessionId
              : undefined;
    if (parentSessionId !== undefined && !returnedIds.has(parentSessionId)) {
        throw new Error(`Session '${session.id}' has a parent outside the returned agent tree.`);
    }
    return {
        agentId: session.agentIdentity().agentId,
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
        modelId: summary.modelId,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        providerId: summary.providerId,
        relation,
        sessionId: session.id,
        status: summary.status,
        ...(metadata.taskName === undefined ? {} : { taskName: metadata.taskName }),
        ...(summary.title === undefined ? {} : { title: summary.title }),
        totalTokens: session.lifetimeTotalTokens(),
    };
}
