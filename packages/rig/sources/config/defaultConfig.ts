import type { RigConfig } from "./types.js";
import { DEFAULT_INFERENCE_MAX_RETRIES } from "./inferenceRetrySettings.js";

export const DEFAULT_RIG_CONFIG: RigConfig = {
    defaults: {
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
    },
    features: {
        crossWorkspace: false,
        workflows: true,
        workspaces: true,
    },
    mcpServers: {},
    p2p: {
        direct: {},
        enableDirect: false,
        enableIroh: false,
        enableSsh: false,
        exposeApi: false,
        iroh: {},
        peers: [],
    },
    presence: { states: {} },
    providerDefaultEnable: true,
    providers: {
        codex: {
            enabled: true,
            type: "codex",
        },
        claude: {
            enabled: true,
            type: "claude",
        },
        bedrock: {
            enabled: true,
            type: "bedrock",
        },
        grok: {
            enabled: true,
            type: "grok",
        },
    },
    settings: {
        inferenceMaxRetries: DEFAULT_INFERENCE_MAX_RETRIES,
        compactCompletedTurns: false,
        completionChime: false,
        daemonHeapSnapshots: false,
        durableGlobalEventQueue: false,
        happyIntegration: true,
        showReasoning: false,
        showUsage: false,
    },
    theme: {
        accent: "cyan",
        brand: "ansi:202",
        error: "red",
        primary: "default",
        secondary: "dim",
        success: "green",
        warning: "yellow",
    },
    workspace: {
        setupCommands: [],
    },
};
