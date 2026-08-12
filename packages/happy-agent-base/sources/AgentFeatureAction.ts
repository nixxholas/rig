import type { SessionUserMessage } from "@slopus/happy-providers";

/**
 * What a lifecycle hook can ask the agent to do next: queue a steering or sent message through
 * the ordinary durable queues, or trigger a compaction. An action drives the loop exactly like
 * an external call to `steer`, `send`, or `compact` would.
 */
export type AgentFeatureAction =
    | { readonly type: "steer"; readonly message: SessionUserMessage }
    | { readonly type: "send"; readonly message: SessionUserMessage }
    | { readonly type: "compact" };
