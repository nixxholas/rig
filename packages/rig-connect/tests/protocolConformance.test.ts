import { describe, expect, it } from "vitest";

// The daemon's own declarations, read from source so this check needs no build
// step and no published type surface. It is a type-only import in a test, so
// nothing from the daemon reaches this library's bundle.
import type * as daemon from "../../rig/sources/protocol/index.js";
// Presentation is owned by the agent layer rather than the protocol module, but
// it travels on the wire all the same, so it is checked the same way.
import type * as daemonAgent from "../../rig/sources/agent/index.js";
import type * as local from "@/protocol.js";

/**
 * The protocol types are declared locally so a browser bundle carries no daemon
 * code, which means nothing stops them drifting from the daemon at runtime.
 *
 * These assertions are the guard: each one fails to compile if the daemon
 * changes a shape this library reads. They are checked by `pnpm check`, so a
 * drift is a build error rather than a bug a user finds.
 */

/** Compiles only when `TValue` is assignable to `TExpected`. */
type Assignable<TExpected, TValue extends TExpected> = TValue;
type EventOf<TEvent, TType extends string> = Extract<TEvent, { type: TType }>;

type _Activity = Assignable<local.SessionActivity, daemon.SessionActivity>;
type _ActivityKind = Assignable<local.SessionActivityKind, daemon.SessionActivityKind>;
type _ActivityToolCall = Assignable<local.SessionActivityToolCall, daemon.SessionActivityToolCall>;
type _ActivityCompaction = Assignable<
    local.SessionActivityCompaction,
    daemon.SessionActivityCompaction
>;
type _ActivityRetry = Assignable<local.SessionActivityRetry, daemon.SessionActivityRetry>;
type _Hello = Assignable<local.SessionStreamHello, daemon.SessionStreamHello>;
type _PartialMessage = Assignable<local.SessionPartialMessage, daemon.SessionPartialMessage>;
type _Git = Assignable<local.GitChangeSnapshot, daemon.GitChangeSnapshot>;
type _TokenCount = Assignable<local.SessionTokenCount, daemon.SessionTokenCount>;
type _UnreadState = Assignable<local.SessionUnreadState, daemon.SessionUnreadState>;
type _UnreadReason = Assignable<local.SessionUnreadReason, daemon.SessionUnreadReason>;
type _Event = Assignable<local.SessionEvent, daemon.SessionEvent>;
type ApplicationReadEventType =
    | "session_updated"
    | "session_activity_changed"
    | "session_git_changed"
    | "session_context_changed"
    | "session_configuration_changed"
    | "permission_mode_changed"
    | "session_title_changed"
    | "session_draft_changed"
    | "secrets_changed"
    | "mcp_servers_changed"
    | "user_input_requested"
    | "user_input_resolved"
    | "tasks_changed"
    | "goal_changed"
    | "workflow_changed"
    | "external_tool_call_requested"
    | "external_tool_call_resolved"
    | "subagent_changed"
    | "shell_command_started"
    | "shell_command_finished"
    | "steering_applied"
    | "message_submitted"
    | "run_started"
    | "agent_message"
    | "agent_event"
    | "provider_quota_observed"
    | "session_quota_contribution_changed"
    | "run_finished"
    | "run_error"
    | "session_reset"
    | "session_rewound";
type _ApplicationReadEvents = {
    [TType in ApplicationReadEventType]: Assignable<
        EventOf<local.InterpretedSessionEvent, TType>,
        EventOf<daemon.SessionEvent, TType>
    >;
};
type _Session = Assignable<local.ProtocolSession, daemon.ProtocolSession>;
type _TranscriptWindow = Assignable<local.SessionTranscriptWindow, daemon.SessionTranscriptWindow>;
type _TranscriptTurn = Assignable<local.SessionTranscriptTurn, daemon.SessionTranscriptTurn>;
type _GlobalHello = Assignable<local.GlobalStreamHello, daemon.GlobalStreamHello>;
type _Project = Assignable<local.Project, daemon.Project>;
type _Workspace = Assignable<local.ProjectWorkspace, daemon.ProjectWorkspace>;
type _SessionSummary = Assignable<local.SessionSummary, daemon.SessionSummary>;
type _GlobalEvent = Assignable<local.GlobalEvent, daemon.GlobalEvent>;
type _CallPresentation = Assignable<local.ToolCallPresentation, daemonAgent.ToolCallPresentation>;
type _ResultPresentation = Assignable<
    local.ToolResultPresentation,
    daemonAgent.ToolResultPresentation
>;
type _FileDiff = Assignable<local.FileDiff, daemonAgent.FileDiff>;
type _ExplorationOperation = Assignable<
    local.ExplorationOperation,
    daemonAgent.ExplorationOperation
>;

describe("protocol conformance", () => {
    it("keeps the embedded protocol types assignable from the daemon's own types", () => {
        // The assertions above are compile-time. This case documents that a
        // failure shows up as a type error rather than as a failing expectation.
        expect(true).toBe(true);
    });
});
