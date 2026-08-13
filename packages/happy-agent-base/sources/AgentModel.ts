import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";

/** One provider/model route available to agents and subagents. */
export interface AgentModel {
    readonly providerId: string;
    readonly id: string;
    readonly name: string;
    readonly effortLevels: readonly SessionReasoningEffort[];
    readonly defaultEffort: SessionReasoningEffort;
    readonly serviceTiers?: readonly SessionServiceTier[];
}
