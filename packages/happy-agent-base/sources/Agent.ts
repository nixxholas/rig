import type { SessionSystemMessage, SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import { AgentBase, type AgentBaseMessageOptions, type AgentBaseOptions } from "./AgentBase.js";
import type { AgentBaseHooks } from "./AgentBaseHooks.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import type { AgentFeature } from "./AgentFeature.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

export interface AgentOptions<Tool extends AnyAgentTool = AnyAgentTool>
    extends Omit<AgentBaseOptions, "hooks"> {
    /** Independent capabilities whose hook implementations are merged, in array order. */
    readonly features?: readonly AgentFeature<Tool>[];
}

/**
 * A thin wrapper around `AgentBase` that assembles its behavior from features. Each feature
 * implements any subset of the agent hooks on its own; the agent merges them into the singular
 * private hooks its internal base runs with. Observing hooks fan out to every feature in array
 * order, instructions concatenate, tools concatenate, lifecycle actions concatenate, and the
 * first feature to answer a reset injection wins.
 */
export class Agent<Tool extends AnyAgentTool = AnyAgentTool> {
    readonly #base: AgentBase;

    constructor(ctx: Context, options: AgentOptions<Tool>) {
        const { features, ...base } = options;
        this.#base = new AgentBase(ctx, {
            ...base,
            hooks: mergeFeatures(features ?? []),
        });
    }

    get id(): string {
        return this.#base.id;
    }

    get state(): AgentBaseState {
        return this.#base.state;
    }

    async steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#base.steer(ctx, message, options);
    }

    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#base.send(ctx, message, options);
    }

    start(): void {
        this.#base.start();
    }

    async waitForIdle(): Promise<void> {
        await this.#base.waitForIdle();
    }

    async compact(ctx: Context): Promise<void> {
        await this.#base.compact(ctx);
    }

    async abort(): Promise<void> {
        await this.#base.abort();
    }

    async close(): Promise<void> {
        await this.#base.close();
    }
}

/**
 * Merge every feature's hook implementations into one `AgentBaseHooks`. A hook is provided only
 * when at least one feature implements it, so the base's own fallbacks — such as the mutable
 * state for instructions and tools — stay in effect otherwise.
 */
function mergeFeatures<Tool extends AnyAgentTool>(
    features: readonly AgentFeature<Tool>[],
): AgentBaseHooks {
    const withInstructions = features.filter((feature) => feature.instructions !== undefined);
    const withTools = features.filter((feature) => feature.tools !== undefined);
    const withModelChanged = features.filter((feature) => feature.modelChanged !== undefined);
    const fanOut = (
        pick: (feature: AgentFeature<Tool>) => ((ctx: Context) => void) | undefined,
    ): ((ctx: Context) => void) | undefined => {
        const implemented = features.filter((feature) => pick(feature) !== undefined);
        if (implemented.length === 0) return undefined;
        return (ctx) => {
            for (const feature of implemented) pick(feature)?.(ctx);
        };
    };
    const collect = (
        pick: (
            feature: AgentFeature<Tool>,
        ) => ((ctx: Context) => readonly AgentFeatureAction[] | undefined) | undefined,
    ): ((ctx: Context) => readonly AgentFeatureAction[] | undefined) | undefined => {
        const implemented = features.filter((feature) => pick(feature) !== undefined);
        if (implemented.length === 0) return undefined;
        return (ctx) => implemented.flatMap((feature) => pick(feature)?.(ctx) ?? []);
    };
    const onEvent = fanOutEvent(features);
    return {
        ...(onEvent === undefined ? {} : { onEvent }),
        ...(withInstructions.length === 0
            ? {}
            : {
                  instructions: (ctx: Context) =>
                      withInstructions
                          .map((feature) => feature.instructions?.(ctx) ?? "")
                          .filter((text) => text.length > 0)
                          .join("\n\n"),
              }),
        ...(withTools.length === 0
            ? {}
            : {
                  tools: (ctx: Context) =>
                      withTools.flatMap((feature) => [...(feature.tools?.(ctx) ?? [])]),
              }),
        ...(withModelChanged.length === 0
            ? {}
            : {
                  modelChanged: (ctx, change) => {
                      let injected: SessionSystemMessage | undefined;
                      // Every feature observes the change; the first returned message wins.
                      for (const feature of withModelChanged) {
                          const message = feature.modelChanged?.(ctx, change);
                          injected ??= message;
                      }
                      return injected;
                  },
              }),
        ...spread("beforeAgentLoop", fanOut((feature) => feature.beforeAgentLoop)),
        ...spread("beforeTurn", fanOut((feature) => feature.beforeTurn)),
        ...spread("beforeInference", fanOut((feature) => feature.beforeInference)),
        ...spread("afterInference", fanOut((feature) => feature.afterInference)),
        ...spread("afterTurn", collect((feature) => feature.afterTurn)),
        ...spread("afterAgentLoop", collect((feature) => feature.afterAgentLoop)),
    };
}

function fanOutEvent<Tool extends AnyAgentTool>(
    features: readonly AgentFeature<Tool>[],
): AgentBaseHooks["onEvent"] {
    const implemented = features.filter((feature) => feature.onEvent !== undefined);
    if (implemented.length === 0) return undefined;
    return (ctx, event) => {
        for (const feature of implemented) feature.onEvent?.(ctx, event);
    };
}

function spread<Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [K in Key]?: Value } {
    return value === undefined ? {} : ({ [key]: value } as { [K in Key]: Value });
}
