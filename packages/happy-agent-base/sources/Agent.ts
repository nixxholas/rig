import type { SessionSystemMessage, SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import {
    AgentBase,
    type AgentBaseAwaitOptions,
    type AgentBaseMessageOptions,
    type AgentBaseOptions,
} from "./AgentBase.js";
import { agentBaseKV, withAgentBaseKV } from "./AgentBaseContext.js";
import type { AgentBaseHooks, MaybePromise } from "./AgentBaseHooks.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import type { AgentFeature } from "./AgentFeature.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

export interface AgentOptions<Tool extends AnyAgentTool = AnyAgentTool> extends Omit<
    AgentBaseOptions,
    "hooks"
> {
    /** Independent capabilities whose hook implementations are merged, in array order. */
    readonly features?: readonly AgentFeature<Tool>[];
}

/**
 * A thin wrapper around `AgentBase` that assembles its behavior from features. Each feature
 * implements any subset of the agent hooks on its own; the agent merges them into the singular
 * private hooks its internal base runs with.
 *
 * Features are independent. Observing hooks — events and lifecycle brackets — fan out to every
 * feature in array order with per-feature isolation, so one throwing feature never silences the
 * others, and lifecycle actions concatenate across features with a failing feature losing only
 * its own actions. Correctness hooks are loud instead: instructions and tools concatenate in
 * feature order — extending the base state, which `AgentBase` puts first — and a failure there
 * fails the turn rather than running with a wrong configuration. For a model change, every
 * feature observes the change, the first returned handoff wins, and a feature failure during an
 * incompatible change rejects the switch so the history survives.
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
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#base.steer(ctx, message, options);
    }

    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#base.send(ctx, message, options);
    }

    start(): void {
        this.#base.start();
    }

    async waitForIdle(): Promise<void> {
        await this.#base.waitForIdle();
    }

    async compact(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void> {
        await this.#base.compact(ctx, options);
    }

    async abort(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void> {
        await this.#base.abort(ctx, options);
    }

    async close(): Promise<void> {
        await this.#base.close();
    }
}

/**
 * Merge every feature's hook implementations into one `AgentBaseHooks`. A hook is provided only
 * when at least one feature implements it, so the base's own behavior — the mutable state alone
 * for instructions and tools — stays in effect otherwise.
 */
function mergeFeatures<Tool extends AnyAgentTool>(
    features: readonly AgentFeature<Tool>[],
): AgentBaseHooks {
    const withInstructions = features.filter((feature) => feature.instructions !== undefined);
    const withTools = features.filter((feature) => feature.tools !== undefined);
    const withModelChanged = features.filter((feature) => feature.modelChanged !== undefined);
    const withEvents = features.filter((feature) => feature.onEvent !== undefined);
    // Observing hooks fan out with per-feature isolation: one throwing feature must never
    // prevent the features after it from observing.
    const fanOut = <Arguments extends readonly unknown[]>(
        pick: (
            feature: AgentFeature<Tool>,
        ) => ((ctx: Context, ...args: Arguments) => MaybePromise<void>) | undefined,
    ): ((ctx: Context, ...args: Arguments) => Promise<void>) | undefined => {
        const implemented = features.filter((feature) => pick(feature) !== undefined);
        if (implemented.length === 0) return undefined;
        return async (ctx, ...args) => {
            for (const feature of implemented) {
                try {
                    await pick(feature)?.(featureCtx(ctx, feature), ...args);
                } catch {
                    // Features observe independently; one failing never silences the rest.
                }
            }
        };
    };
    // Action hooks concatenate what every feature asks for; a failing feature loses only its
    // own actions.
    const collect = <Arguments extends readonly unknown[]>(
        pick: (
            feature: AgentFeature<Tool>,
        ) =>
            | ((
                  ctx: Context,
                  ...args: Arguments
              ) => MaybePromise<readonly AgentFeatureAction[] | undefined>)
            | undefined,
    ):
        | ((ctx: Context, ...args: Arguments) => Promise<readonly AgentFeatureAction[]>)
        | undefined => {
        const implemented = features.filter((feature) => pick(feature) !== undefined);
        if (implemented.length === 0) return undefined;
        return async (ctx, ...args) => {
            const actions: AgentFeatureAction[] = [];
            for (const feature of implemented) {
                try {
                    actions.push(
                        ...((await pick(feature)?.(featureCtx(ctx, feature), ...args)) ?? []),
                    );
                } catch {
                    // Features act independently; one failing never discards the rest.
                }
            }
            return actions;
        };
    };
    return {
        ...(withEvents.length === 0
            ? {}
            : {
                  onEvent: ((ctx, event) => {
                      for (const feature of withEvents) {
                          try {
                              feature.onEvent?.(featureCtx(ctx, feature), event);
                          } catch {
                              // Features observe independently; one failing never silences
                              // the rest.
                          }
                      }
                  }) satisfies AgentBaseHooks["onEvent"],
              }),
        ...(withInstructions.length === 0
            ? {}
            : {
                  // Correctness hook: a failing feature propagates and fails the turn.
                  instructions: async (ctx: Context) => {
                      const texts: string[] = [];
                      for (const feature of withInstructions) {
                          texts.push(
                              (await feature.instructions?.(featureCtx(ctx, feature))) ?? "",
                          );
                      }
                      return texts.filter((text) => text.length > 0).join("\n\n");
                  },
              }),
        ...(withTools.length === 0
            ? {}
            : {
                  // Correctness hook: a failing feature propagates and fails the turn; the
                  // base validates the merged list against duplicate names.
                  tools: async (ctx: Context) => {
                      const tools: AnyAgentTool[] = [];
                      for (const feature of withTools) {
                          tools.push(...((await feature.tools?.(featureCtx(ctx, feature))) ?? []));
                      }
                      return tools;
                  },
              }),
        ...(withModelChanged.length === 0
            ? {}
            : {
                  modelChanged: async (ctx, change) => {
                      let injected: SessionSystemMessage | undefined;
                      let failed = false;
                      let failure: unknown;
                      // Every feature observes the change even when an earlier one fails;
                      // the first returned handoff wins.
                      for (const feature of withModelChanged) {
                          try {
                              const message = await feature.modelChanged?.(
                                  featureCtx(ctx, feature),
                                  change,
                              );
                              injected ??= message;
                          } catch (error: unknown) {
                              if (!failed) {
                                  failed = true;
                                  failure = error;
                              }
                          }
                      }
                      // A failing feature during an incompatible change rejects the switch,
                      // preserving the history; on a compatible change it merely observed.
                      if (failed && change.wasReset) throw failure;
                      return injected;
                  },
              }),
        ...spread(
            "beforeAgentLoop",
            fanOut((feature) => feature.beforeAgentLoop),
        ),
        ...spread(
            "beforeTurn",
            collect((feature) => feature.beforeTurn),
        ),
        ...spread(
            "beforeInference",
            fanOut((feature) => feature.beforeInference),
        ),
        ...spread(
            "afterInference",
            fanOut((feature) => feature.afterInference),
        ),
        ...spread(
            "afterTurn",
            collect((feature) => feature.afterTurn),
        ),
        ...spread(
            "afterAgentLoop",
            collect((feature) => feature.afterAgentLoop),
        ),
        ...spread(
            "afterAgentSettled",
            fanOut((feature) => feature.afterAgentSettled),
        ),
    };
}

/**
 * The context a feature's hooks run on: the agent's context with the key-value store narrowed
 * to the feature's own name, so features never see each other's persisted entries.
 */
function featureCtx(ctx: Context, feature: { readonly name: string }): Context {
    const kv = agentBaseKV(ctx);
    return kv === undefined ? ctx : withAgentBaseKV(ctx, kv.scoped("feature", feature.name));
}

function spread<Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [K in Key]?: Value } {
    return value === undefined ? {} : ({ [key]: value } as { [K in Key]: Value });
}
