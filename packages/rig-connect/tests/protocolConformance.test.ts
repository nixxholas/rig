import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { happyComputeErrorSchema } from "../../happy-plugins/sources/computeTypes.js";

// The daemon's own declarations are read from source so this check needs no
// build step and no published type surface. Type-only imports preserve the
// browser bundle boundary; runtime schema imports run only in this Vitest
// conformance check.
import type * as daemon from "../../rig/sources/protocol/index.js";
import {
    PROJECT_ERROR_MAX_LENGTH as DAEMON_PROJECT_ERROR_MAX_LENGTH,
    createSessionShareRequestSchema as daemonCreateSessionShareRequestSchema,
    rigCliInstallationInspectionSchema as daemonRigCliInstallationInspectionSchema,
    rigDaemonInstallationDiscoverySchema as daemonRigDaemonInstallationDiscoverySchema,
    rigDataEpochSchema as daemonRigDataEpochSchema,
    rigInitializedDataSchema as daemonRigInitializedDataSchema,
    rigInstallationDataSchema as daemonRigInstallationDataSchema,
    sessionShareOwnerResponseSchema as daemonSessionShareOwnerResponseSchema,
    systemNoticePayloadSchema as daemonSystemNoticePayloadSchema,
} from "../../rig/sources/protocol/index.js";
// Presentation is owned by the agent layer rather than the protocol module, but
// it travels on the wire all the same, so it is checked the same way.
import type * as daemonAgent from "../../rig/sources/agent/index.js";
import type * as local from "@/protocol.js";
import type * as localInstallation from "@/RigInstallationInspection.js";
import {
    PROJECT_WORKSPACE_ERROR_MAX_LENGTH,
    SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    computeServiceErrorSchema,
    createSessionShareRequestSchema,
    projectWorkspaceSchema,
    sessionShareOwnerResponseSchema,
    systemNoticePayloadSchema,
} from "@/protocol.js";
import {
    rigCliInstallationInspectionSchema,
    rigDaemonInstallationDiscoverySchema,
    rigDataEpochSchema,
    rigInitializedDataSchema,
    rigInstallationCliDataSchema,
} from "@/RigInstallationInspection.js";

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
type _ActivityPermissionReview = Assignable<
    local.SessionActivityPermissionReview,
    daemon.SessionActivityPermissionReview
>;
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
type _SessionSharedMetadata = Assignable<local.SessionSharedMetadata, daemon.SessionSharedMetadata>;
type _CreateSessionShareRequest = Assignable<
    local.CreateSessionShareRequest,
    daemon.CreateSessionShareRequest
>;
type _SessionShareOwnerResponse = Assignable<
    local.SessionShareOwnerResponse,
    daemon.SessionShareOwnerResponse
>;
type _Event = Assignable<local.SessionEvent, daemon.SessionEvent>;
type _ServiceNotice = Assignable<local.ServiceNotice, daemon.ServiceNotice>;
type _SystemNoticePayload = Assignable<local.SystemNoticePayload, daemon.SystemNoticePayload>;
type _DaemonServiceNotice = Assignable<daemon.ServiceNotice, local.ServiceNotice>;
type _DaemonSystemNoticePayload = Assignable<daemon.SystemNoticePayload, local.SystemNoticePayload>;
type _SystemMessage = Assignable<local.SystemMessage, daemonAgent.SystemMessage>;
type _TranscriptNotice = Assignable<local.SessionTranscriptNotice, daemon.SessionTranscriptNotice>;
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
type _ProjectRegistrationErrorCode = Assignable<
    local.ProjectRegistrationErrorCode,
    daemon.ProjectRegistrationErrorCode
>;
type _Workspace = Assignable<local.ProjectWorkspace, daemon.ProjectWorkspace>;
type _WorkspaceExact = Assignable<daemon.ProjectWorkspace, local.ProjectWorkspace>;
type _WorkspaceErrorMaxLength = Assignable<
    typeof PROJECT_WORKSPACE_ERROR_MAX_LENGTH,
    typeof DAEMON_PROJECT_ERROR_MAX_LENGTH
>;
type _SessionSummary = Assignable<local.SessionSummary, daemon.SessionSummary>;
type _GlobalEvent = Assignable<local.GlobalEvent, daemon.GlobalEvent>;
type _HappyCloudStatus = Assignable<local.HappyCloudStatus, daemon.HappyCloudStatus>;
type _HappyCloudChangedEvent = Assignable<
    local.HappyCloudChangedEvent,
    daemon.HappyCloudChangedEvent
>;
type _HappyCloudCommand = Assignable<daemon.HappyCloudCommand, local.HappyCloudCommand>;
type _HappyCloudCommandResponse = Assignable<
    local.HappyCloudCommandResponse,
    daemon.HappyCloudCommandResponse
>;
type _HappyCloudProfile = Assignable<
    local.HappyCloudProfileCiphertextResponse,
    daemon.HappyCloudProfileCiphertextResponse
>;
type _HappyCloudSessionBlob = Assignable<
    local.HappyCloudSessionBlobResponse,
    daemon.HappyCloudSessionBlobResponse
>;
type _Attachment = Assignable<local.Attachment, daemon.Attachment>;
type _Webapp = Assignable<local.Webapp, daemon.Webapp>;
type _ResolveWebappOpenRequest = Assignable<
    daemon.ResolveWebappOpenRequest,
    local.ResolveWebappOpenRequest
>;
type _ResolveWebappOpenResponse = Assignable<
    local.ResolveWebappOpenResponse,
    daemon.ResolveWebappOpenResponse
>;
type _WebappContext = Assignable<local.WebappContext, daemon.WebappContext>;
type _SlotAction = Assignable<local.SlotAction, daemon.SlotAction>;
type LocalOpenWebappAction = Extract<local.SlotAction, { type: "open-webapp" }>;
type DaemonOpenWebappAction = Extract<daemon.SlotAction, { type: "open-webapp" }>;
type _OpenWebappPath = Assignable<DaemonOpenWebappAction["path"], LocalOpenWebappAction["path"]>;
type _OpenWebappQuery = Assignable<DaemonOpenWebappAction["query"], LocalOpenWebappAction["query"]>;
type _PluginSummary = Assignable<local.PluginSummary, daemon.PluginSummary>;
type _PluginLog = Assignable<local.PluginLogSnapshot, daemon.PluginLogSnapshot>;
type _PluginList = Assignable<local.ListPluginsResponse, daemon.ListPluginsResponse>;
type _PluginLogResponse = Assignable<local.PluginLogResponse, daemon.PluginLogResponse>;
type _InstallPluginRequest = Assignable<daemon.InstallPluginRequest, local.InstallPluginRequest>;
type _DiscoverPluginCatalogRequest = Assignable<
    daemon.DiscoverPluginCatalogRequest,
    local.DiscoverPluginCatalogRequest
>;
type _DiscoverPluginCatalogResponse = Assignable<
    local.GitHubPluginCatalog,
    daemon.DiscoverPluginCatalogResponse
>;
type _InstallPluginResponse = Assignable<local.InstallPluginResponse, daemon.InstallPluginResponse>;
type _UninstallPluginResponse = Assignable<
    local.UninstallPluginResponse,
    daemon.UninstallPluginResponse
>;
type _PluginManagementErrorResponse = Assignable<
    local.PluginManagementErrorResponse,
    daemon.PluginManagementErrorResponse
>;
type _MurmurAccount = Assignable<local.MurmurAccount, daemon.MurmurAccount>;
type _MurmurProfile = Assignable<local.MurmurProfile, daemon.MurmurProfile>;
type _MurmurPhoto = Assignable<local.MurmurPhoto, daemon.MurmurPhoto>;
type _MurmurServiceState = Assignable<local.MurmurServiceState, daemon.MurmurServiceState>;
type _SignupMurmurRequest = Assignable<
    daemon.SignupMurmurAccountRequest,
    local.SignupMurmurAccountRequest
>;
type _SignupMurmurResponse = Assignable<
    local.SignupMurmurAccountResponse,
    daemon.SignupMurmurAccountResponse
>;
type _MurmurFriendRequest = Assignable<local.MurmurFriendRequest, daemon.MurmurFriendRequest>;
type _MurmurContact = Assignable<local.MurmurContact, daemon.MurmurContact>;
type _MurmurFriendship = Assignable<local.MurmurFriendship, daemon.MurmurFriendship>;
type _MurmurFriendStats = Assignable<local.MurmurFriendStats, daemon.MurmurFriendStats>;
type _MurmurFriendsResponse = Assignable<
    local.GetMurmurFriendsResponse,
    daemon.GetMurmurFriendsResponse
>;
type _TimelineScope = Assignable<local.TimelineScope, daemon.TimelineScope>;
type _TimelineSpan = Assignable<local.TimelineSpan, daemon.TimelineSpan>;
type _TimelineSpanKind = Assignable<local.TimelineSpanKind, daemon.TimelineSpanKind>;
type _TimelineSpanOutcome = Assignable<local.TimelineSpanOutcome, daemon.TimelineSpanOutcome>;
type _TimelineAgent = Assignable<local.TimelineAgent, daemon.TimelineAgent>;
type _TimelineResponse = Assignable<local.GetTimelineResponse, daemon.GetTimelineResponse>;
// The other direction too: a request this library sends must be one the daemon
// accepts, or a chart would ask for something that cannot be answered.
type _TimelineRequest = Assignable<daemon.GetTimelineRequest, local.GetTimelineRequest>;
type _CallPresentation = Assignable<local.ToolCallPresentation, daemonAgent.ToolCallPresentation>;
type _ResultPresentation = Assignable<
    local.ToolResultPresentation,
    daemonAgent.ToolResultPresentation
>;
type _FileDiff = Assignable<local.FileDiff, daemonAgent.FileDiff>;
// Usage is polled rather than streamed, so this is the only shape a view reads
// through a request of its own.
type _ProviderUsage = Assignable<local.ProviderUsage, daemon.ProviderUsage>;
type _ProviderUsageEntry = Assignable<local.ProviderUsageEntry, daemon.ProviderUsageEntry>;
type _ProviderUsageList = Assignable<
    local.ListProviderUsageResponse,
    daemon.ListProviderUsageResponse
>;
type _ExplorationOperation = Assignable<
    local.ExplorationOperation,
    daemonAgent.ExplorationOperation
>;
type _RigCliInstallationInspection = Assignable<
    localInstallation.RigCliInstallationInspection,
    daemon.RigCliInstallationInspection
>;
type _DaemonRigCliInstallationInspection = Assignable<
    daemon.RigCliInstallationInspection,
    localInstallation.RigCliInstallationInspection
>;
type _RigDaemonInstallationDiscovery = Assignable<
    localInstallation.RigDaemonInstallationDiscovery,
    daemon.RigDaemonInstallationDiscovery
>;
type _DaemonRigDaemonInstallationDiscovery = Assignable<
    daemon.RigDaemonInstallationDiscovery,
    localInstallation.RigDaemonInstallationDiscovery
>;

describe("protocol conformance", () => {
    it("keeps the browser-safe compute error schema structurally identical to the daemon source", () => {
        expect(computeServiceErrorSchema).toEqual(happyComputeErrorSchema);
    });

    it("keeps duplicated installation schemas structurally identical to the daemon", () => {
        expect(rigDataEpochSchema).toStrictEqual(daemonRigDataEpochSchema);
        expect(rigInitializedDataSchema).toStrictEqual(daemonRigInitializedDataSchema);
        expect(rigInstallationCliDataSchema).toStrictEqual(daemonRigInstallationDataSchema);
        expect(rigCliInstallationInspectionSchema).toStrictEqual(
            daemonRigCliInstallationInspectionSchema,
        );
        expect(rigDaemonInstallationDiscoverySchema).toStrictEqual(
            daemonRigDaemonInstallationDiscoverySchema,
        );

        const preIdentityUpgradeRequired = {
            message: "Existing Rig data must be opened by a newer Rig before it has an identity.",
            reason: "pre_identity",
            schemaVersion: 16,
            status: "upgrade_required",
        };
        expect(Value.Check(rigInstallationCliDataSchema, preIdentityUpgradeRequired)).toBe(true);
        expect(Value.Check(daemonRigInstallationDataSchema, preIdentityUpgradeRequired)).toBe(true);
        for (const invalidPreIdentityUpgradeRequired of [
            { ...preIdentityUpgradeRequired, epoch: "must-not-exist" },
            { ...preIdentityUpgradeRequired, unexpected: true },
        ]) {
            expect(
                Value.Check(rigInstallationCliDataSchema, invalidPreIdentityUpgradeRequired),
            ).toBe(false);
            expect(
                Value.Check(daemonRigInstallationDataSchema, invalidPreIdentityUpgradeRequired),
            ).toBe(false);
        }

        const invalidDiscoveryValues = [
            {
                daemonProtocolVersion: 5,
                daemonVersion: "0.0.127",
                data: {
                    epoch: "installation-epoch",
                    schemaCompatibility: "current",
                    schemaVersion: 18,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
                unexpected: true,
            },
            {
                daemonProtocolVersion: 5,
                daemonVersion: "0.0.127",
                data: {
                    epoch: "x".repeat(129),
                    schemaCompatibility: "current",
                    schemaVersion: 18,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
            },
            {
                daemonProtocolVersion: 5,
                daemonVersion: "0.0.127",
                data: {
                    epoch: "installation-epoch",
                    schemaCompatibility: "current",
                    schemaVersion: -1,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
            },
        ];

        for (const value of invalidDiscoveryValues) {
            expect(Value.Check(rigDaemonInstallationDiscoverySchema, value)).toBe(false);
            expect(Value.Check(daemonRigDaemonInstallationDiscoverySchema, value)).toBe(false);
        }
    });

    it("keeps the embedded protocol types assignable from the daemon's own types", () => {
        // The assertions above are compile-time. This case documents that a
        // failure shows up as a type error rather than as a failing expectation.
        expect(true).toBe(true);
    });

    it("round-trips a structured compute notice with its text fallback", () => {
        const payload: local.SystemNoticePayload = {
            structured: {
                computeInstanceId: "compute-1",
                elapsedMs: 45_000,
                error: {
                    code: "preparing_compute",
                    elapsedMs: 45_000,
                    lastProgressAt: 30_000,
                    message: "The compute provider is recovering.",
                    percent: 40,
                    phase: "waiting_for_sandbox",
                    retryable: true,
                    startedAt: 10_000,
                    state: "unavailable",
                },
                kind: "compute_preparation",
                lastProgressAt: 30_000,
                message: "Waiting for the sandbox to start.",
                percent: 40,
                phase: "waiting_for_sandbox",
                provider: "daytona",
                startedAt: 10_000,
                state: "unavailable",
            },
            text: "Preparing compute: Waiting for the sandbox to start. (45s)",
        };

        const serialized = JSON.parse(JSON.stringify(payload));
        const decoded = Value.Decode(systemNoticePayloadSchema, serialized);

        expect(decoded).toEqual(payload);
        expect(Value.Decode(daemonSystemNoticePayloadSchema, serialized)).toEqual(payload);
        expect(decoded.text).toBe("Preparing compute: Waiting for the sandbox to start. (45s)");
    });

    it("validates the exact bounded workspace contract", () => {
        const workspace: local.ProjectWorkspace = {
            createdAt: 1,
            error: "x".repeat(PROJECT_WORKSPACE_ERROR_MAX_LENGTH),
            gitCommonDir: "/work/project/.git",
            id: "workspace-1",
            kind: "git_worktree",
            name: "Workspace",
            orderKey: "a",
            path: "/work/project/workspace-1",
            presence: "present",
            projectId: "project-1",
            status: "failed",
            storageKey: "workspace-1",
            updatedAt: 2,
            version: 3,
        };

        expect(PROJECT_WORKSPACE_ERROR_MAX_LENGTH).toBe(DAEMON_PROJECT_ERROR_MAX_LENGTH);
        expect(Value.Check(projectWorkspaceSchema, workspace)).toBe(true);
        expect(Value.Decode(projectWorkspaceSchema, workspace)).toEqual(workspace);
        expect(
            Value.Check(projectWorkspaceSchema, {
                ...workspace,
                error: `${workspace.error}x`,
            }),
        ).toBe(false);
        expect(Value.Check(projectWorkspaceSchema, { ...workspace, unexpected: true })).toBe(false);
        expect(() =>
            Value.Decode(projectWorkspaceSchema, {
                ...workspace,
                error: `${workspace.error}x`,
            }),
        ).toThrow();
        expect(() =>
            Value.Decode(projectWorkspaceSchema, { ...workspace, unexpected: true }),
        ).toThrow();
    });

    it("decodes the same bounded session-sharing requests and owner responses", () => {
        const request = {
            friends: [{ displayName: "Ada", peerId: "peer-1" }],
            includeFriendMessagesInModel: true,
            mutationId: "mutation-1",
        };
        const response = {
            members: [
                {
                    createdAt: 1,
                    currentGrantEpoch: 1,
                    displayName: "Ada",
                    murmurPeerId: "peer-1",
                    shareId: "share-1",
                    shareMemberId: "member-1",
                    state: "active",
                    updatedAt: 1,
                },
            ],
            share: {
                includeFriendMessagesInModel: true,
                memberCount: 1,
                shareId: "share-1",
                state: "active",
            },
        };

        expect(Value.Decode(createSessionShareRequestSchema, request)).toEqual(request);
        expect(Value.Decode(daemonCreateSessionShareRequestSchema, request)).toEqual(request);
        expect(Value.Decode(sessionShareOwnerResponseSchema, response)).toEqual(response);
        expect(Value.Decode(daemonSessionShareOwnerResponseSchema, response)).toEqual(response);
    });

    it("rejects compute error detail beyond the daemon's canonical bound", () => {
        const payload = {
            structured: {
                computeInstanceId: "compute-1",
                error: {
                    code: "instance_failed",
                    message: "x".repeat(SERVICE_NOTICE_MESSAGE_MAX_LENGTH + 1),
                    retryable: false,
                    state: "failed",
                },
                kind: "compute_preparation",
                message: "Compute failed.",
                phase: "failed",
                provider: "daytona",
                state: "failed",
            },
            text: "Compute preparation failed.",
        };

        expect(() => Value.Decode(systemNoticePayloadSchema, payload)).toThrow();
        expect(() => Value.Decode(daemonSystemNoticePayloadSchema, payload)).toThrow();
    });
});
