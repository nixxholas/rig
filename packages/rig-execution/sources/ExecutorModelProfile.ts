import type {
    ProviderModelCompatibilityType,
    SessionMessage,
    SessionReasoningEffort,
    SessionServiceTier,
    SessionStructuredOutput,
    SessionTool,
} from "@slopus/rig-providers";
import type { Model } from "@/types.js";

export interface ExecutorModelProfile {
    collaborationMode?: "direct" | "namespaced";
    contextWindow?: number;
    defaultEffort?: SessionReasoningEffort;
    /** Reachable for inference but never offered for selection, such as the Auto review model. */
    hidden?: boolean;
    id: string;
    model: Model;
    name: string;
    providerId: string;
    providerType: ProviderModelCompatibilityType;
    serviceTiers?: readonly SessionServiceTier[];
    prompt: string;
}

export interface ExecutorSelection {
    modelId: string;
    providerId: string;
}

export interface ExecutorRunRequest {
    abort?: AbortSignal;
    context: { readonly messages: readonly SessionMessage[] };
    effort?: SessionReasoningEffort;
    tools?: readonly SessionTool[];
    selection: ExecutorSelection;
    serviceTier?: SessionServiceTier;
    structuredOutput?: SessionStructuredOutput;
    contextInstructions?: string;
    systemPrompt?: string;
}
