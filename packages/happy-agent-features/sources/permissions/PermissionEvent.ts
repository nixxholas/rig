import type { AgentPermissionMode } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** Everything that happened to one agent's permissions, as the feature saw it. */
export type PermissionEvent =
    | {
          readonly type: "permission_mode_changed";
          readonly agentId: string;
          readonly previousMode: AgentPermissionMode;
          readonly mode: AgentPermissionMode;
      }
    | {
          readonly type: "permission_action_reviewed";
          readonly agentId: string;
          readonly callId: string;
          readonly tool: string;
          /** What the reviewer was deciding on. */
          readonly action: string;
          /** Whether allowing it also lifted the sandbox for the length of the call. */
          readonly elevated: boolean;
      }
    | {
          readonly type: "permission_action_denied";
          readonly agentId: string;
          readonly callId: string;
          readonly tool: string;
          readonly action: string;
          /** Why the reviewer refused, in the words it refused with. */
          readonly reason: string;
      }
    | {
          /** The reviewer never answered, so nothing was decided and the action did not happen. */
          readonly type: "permission_action_unproven";
          readonly agentId: string;
          readonly callId: string;
          readonly tool: string;
          readonly action: string;
          readonly reason: string;
      }
    | {
          /** The tool cannot be contained by the mode in force, so it was not offered a review. */
          readonly type: "permission_action_out_of_mode";
          readonly agentId: string;
          readonly callId: string;
          readonly tool: string;
          readonly mode: AgentPermissionMode;
      }
    | {
          /** Refusal after refusal, so the turn was ended rather than left trying. */
          readonly type: "permission_turn_stopped";
          readonly agentId: string;
          readonly refusals: number;
      };

/**
 * Whoever the permissions feature reports to. Both callbacks see the same events; what differs is
 * when.
 *
 * `onEventTransactional` runs inside the transaction that commits the change it describes, which
 * only a mode change has: a listener writing a record of its own commits it with the change, and
 * its failure rolls both back. `onEvent` runs once the change is durable, and every decision about
 * a single tool call — which commits nothing — is reported only there.
 */
export interface PermissionFeatureListener {
    /** Called inside the transaction that commits the change, before it commits. */
    readonly onEventTransactional?: (ctx: Context, event: PermissionEvent) => Promise<void> | void;
    /** Called once the change is durable, or immediately for events that change nothing. */
    readonly onEvent?: (ctx: Context, event: PermissionEvent) => void;
}
