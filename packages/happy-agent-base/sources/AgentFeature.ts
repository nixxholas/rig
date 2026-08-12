import type { SessionEvent, SessionSystemMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentBaseModelChange } from "./AgentBaseHooks.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

/**
 * One independent capability of an `Agent`: a feature implements any subset of the agent hooks,
 * and the agent merges every feature's implementations into the singular hooks its internal
 * `AgentBase` runs with. The hook contracts are the same as `AgentBaseHooks`; see there for
 * when each hook fires and what its return value means.
 */
export interface AgentFeature<Tool extends AnyAgentTool = AnyAgentTool> {
    readonly onEvent?: (ctx: Context, event: SessionEvent) => void;
    /** Merged with every other feature's instructions, in feature order. */
    readonly instructions?: (ctx: Context) => string;
    /** Merged with every other feature's tools, in feature order. */
    readonly tools?: (ctx: Context) => readonly Tool[];
    /** The first feature that returns a handoff message wins the reset injection. */
    readonly modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => SessionSystemMessage | undefined;
    readonly beforeAgentLoop?: (ctx: Context) => void;
    readonly beforeTurn?: (ctx: Context) => void;
    readonly beforeInference?: (ctx: Context) => void;
    readonly afterInference?: (ctx: Context) => void;
    /** Actions from every feature are concatenated and applied together. */
    readonly afterTurn?: (ctx: Context) => readonly AgentFeatureAction[] | undefined;
    /** Actions from every feature are concatenated and applied together. */
    readonly afterAgentLoop?: (ctx: Context) => readonly AgentFeatureAction[] | undefined;
}
