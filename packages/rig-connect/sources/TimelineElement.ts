import type { ConnectionState } from "./ChatElement.js";
import type { TimelineScope, TimelineSpan } from "./protocol.js";

/**
 * One agent's row in the chart, with the agents it started nested inside it.
 *
 * The daemon reports agents as a flat list; joining them into this tree is the
 * library's job, done once so no consumer repeats it.
 */
export interface TimelineAgentNode {
    readonly agentId: string;
    readonly children: readonly TimelineAgentNode[];
    readonly createdAt: number;
    readonly depth: number;
    /** When the last of this agent's work ended; absent while anything is open. */
    readonly endedAt?: number;
    readonly label: string;
    readonly modelId: string;
    readonly parentSessionId?: string;
    readonly parentToolCallId?: string;
    readonly projectId: string;
    readonly providerId: string;
    readonly sessionId: string;
    readonly spans: readonly TimelineSpan[];
    /** When this agent first did anything, which is where its bar begins. */
    readonly startedAt: number;
    readonly type: "primary" | "subagent";
    readonly workspaceId?: string;
}

/** Live facts about the chart as a whole. */
export interface TimelineState {
    readonly connection: ConnectionState;
    /** The earliest moment any covered agent did anything. */
    readonly from?: number;
    readonly scope: TimelineScope;
    /** The latest moment work ended; absent while any agent is still going. */
    readonly to?: number;
}

/** What changed, for a consumer that reacts rather than redrawing everything. */
export type TimelineDelta =
    | { type: "timeline_changed"; agents: readonly TimelineAgentNode[] }
    | { type: "timeline_state_changed"; state: TimelineState }
    | { type: "agent_added"; sessionId: string }
    | { type: "span_started"; kind: TimelineSpan["kind"]; sessionId: string }
    | { type: "span_ended"; kind: TimelineSpan["kind"]; sessionId: string };
