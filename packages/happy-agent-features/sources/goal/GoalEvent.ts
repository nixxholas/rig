import type { Context } from "@steve.kite/stdlib";

import type { SessionGoal } from "./SessionGoal.js";

/** Something that happened to one agent's goal. */
export type GoalEvent =
    | { readonly type: "goal_set"; readonly agentId: string; readonly goal: SessionGoal }
    | { readonly type: "goal_status_changed"; readonly agentId: string; readonly goal: SessionGoal }
    | { readonly type: "goal_cleared"; readonly agentId: string };

/**
 * Whoever the goal feature reports to. Both callbacks see the same events; what differs is when.
 *
 * `onEventTransactional` runs inside the transaction that commits the change, so a listener
 * writing a conclusion of its own commits it with the change itself, and a failure rolls both
 * back. `onEvent` runs afterwards, once the change is durable, and is where work that must not
 * be able to undo the goal belongs.
 */
export interface GoalFeatureListener {
    /** Called inside the transaction that commits the change, before it commits. */
    readonly onEventTransactional?: (ctx: Context, event: GoalEvent) => Promise<void> | void;
    /** Called after the change has committed. */
    readonly onEvent?: (ctx: Context, event: GoalEvent) => void;
}
