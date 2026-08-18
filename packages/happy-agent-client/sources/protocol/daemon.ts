/** The daemon itself: its greeting, health, configuration, and debug surface. */

import type { Effort, PermissionMode, ServiceTier } from "./common.js";

/**
 * The wire protocol this client was built for.
 *
 * A daemon reports its own number through `GET /v0/health`; a client that reads
 * a different one refuses to talk to that daemon.
 */
export const HAPPY_AGENT_PROTOCOL_VERSION = 17;

/** `GET /` — a greeting confirming the caller reached a Happy agent. */
export interface GreetingResponse {
    text: string;
}

/** What a daemon says about itself. */
export interface DaemonVersion {
    /** The wire protocol number; the client's compatibility check. */
    protocol: number;
    /** The product version string, for display and diagnostics. */
    daemon: string;
}

/** `GET /v0/health` */
export interface HealthResponse {
    /** Always `true`; a daemon that cannot answer does not answer. */
    healthy: boolean;
    /** `false` while the agent system is still loading. */
    ready: boolean;
    status: "starting" | "ready";
    version: DaemonVersion;
}

/** What a new agent gets when it names nothing. */
export interface ConfigDefaults {
    providerId: string;
    modelId: string;
    effort: Effort;
    permissionMode: PermissionMode;
}

export interface ConfigFeatures {
    crossWorkspace: boolean;
    workflows: boolean;
    workspaces: boolean;
}

/** A configured MCP server, stripped of everything private. */
export interface McpServerConfig {
    enabled: boolean;
    transport: "stdio" | "http";
}

/** The sandbox network policy. */
export interface NetworkConfig {
    allowedDomains: string[];
    deniedDomains: string[];
    allowedPorts: number[];
    allowedLoopbackPorts: number[];
    allowLocalBinding: boolean;
}

/** Peer-to-peer identity and transports. */
export interface P2pConfig {
    name: string;
    role: string;
    enableIroh: boolean;
    enableDirect: boolean;
    enableSsh: boolean;
    exposeApi: boolean;
}

export interface PermissionsConfig {
    /** Project-relative paths that mutations must not touch unattended. */
    protectedPaths: string[];
}

/** One presence state the person can be in. */
export interface PresenceState {
    title: string;
    emoji: string;
    /** What the model is told about the person's availability. */
    prompt: string;
    /** How long a question waits for an answer; `null` waits indefinitely. */
    answerWaitMs: number | null;
}

export interface PresenceConfig {
    current: string;
    fallback: string;
    states: Record<string, PresenceState>;
}

/** Everything a client needs to present a model, defined once. */
export interface ModelDefinition {
    name: string;
    efforts: Effort[];
    defaultEffort: Effort;
    /** Empty when the model has no service tiers. */
    serviceTiers: ServiceTier[];
}

/**
 * A provider's reference to a model in the top-level catalog.
 *
 * A provider that serves a model with narrower capabilities than the shared
 * definition overrides just those fields.
 */
export interface ProviderModelReference {
    id: string;
    enabled: boolean;
    name?: string;
    efforts?: Effort[];
    defaultEffort?: Effort;
    serviceTiers?: ServiceTier[];
}

export interface ProviderConfig {
    /** The canonical provider key: `"claude"`, `"codex"`, `"grok"`, … */
    type: string;
    enabled: boolean;
    models: ProviderModelReference[];
}

/** Daemon behavior toggles and tunables. */
export interface DaemonSettings {
    compactCompletedTurns: boolean;
    completionChime: boolean;
    inferenceMaxRetries: number;
    showReasoning: boolean;
    showUsage: boolean;
    toolResultRetentionDays: number;
}

/** Terminal color assignments. */
export interface ThemeConfig {
    primary: string;
    secondary: string;
    accent: string;
    brand: string;
    success: string;
    warning: string;
    error: string;
}

/** Workspace lifecycle configuration. */
export interface WorkspaceConfig {
    keepCopiesOnArchive: boolean;
    keepWorktreesOnArchive: boolean;
    setupCommands: string[];
    /** Files copied into every new workspace. */
    sync: string[];
    protectedSync: string[];
}

/** The daemon's effective configuration, with every secret removed. */
export interface DaemonConfig {
    defaults: ConfigDefaults;
    features: ConfigFeatures;
    mcpServers: Record<string, McpServerConfig>;
    network: NetworkConfig;
    p2p: P2pConfig;
    permissions: PermissionsConfig;
    presence: PresenceConfig;
    /** Every model the daemon knows, keyed by model ID. */
    models: Record<string, ModelDefinition>;
    providers: Record<string, ProviderConfig>;
    settings: DaemonSettings;
    theme: ThemeConfig;
    workspace: WorkspaceConfig;
}

/** `GET /v0/config` */
export interface ConfigResponse {
    config: DaemonConfig;
}

/**
 * `PATCH /v0/config` — a runtime settings change.
 *
 * The specification validates the body against "the mutable subset" without
 * enumerating it, so the type admits a partial of any group and leaves the
 * daemon to refuse what it will not change at runtime.
 */
export type ConfigPatch = {
    [Group in keyof DaemonConfig]?: Partial<DaemonConfig[Group]>;
};

/** `GET` and `PUT /v0/config/instructions` */
export interface InstructionsResponse {
    instructions: string;
}

/** `GET` and `PUT /v0/config/security` */
export interface SecurityPolicyResponse {
    policy: string;
}

/** `POST /v0/shutdown` */
export interface ShutdownResponse {
    shuttingDown: boolean;
    /** The daemon's process ID, so the caller can confirm the process exited. */
    pid: number;
}

/** `POST /v0/debug/inspector` */
export interface InspectorStartedResponse {
    /** The devtools websocket URL a debugger attaches to. */
    inspectorUrl: string;
}

/** `DELETE /v0/debug/inspector` */
export interface InspectorStoppedResponse {
    /** `false` when no inspector was running. */
    stopped: boolean;
}

/** `GET /v0/onboarding` */
export interface OnboardingState {
    /** Set explicitly when the person finished or dismissed onboarding. */
    completed: boolean;
    steps: OnboardingSteps;
}

export interface OnboardingSteps {
    /** At least one provider has working credentials. */
    providers: { done: boolean; signedIn: string[] };
    /** The profile has a name. */
    profile: { done: boolean };
    /** At least one project exists. */
    project: { done: boolean };
}

/** `POST /v0/onboarding/complete` */
export interface OnboardingCompletedResponse {
    completed: boolean;
}
