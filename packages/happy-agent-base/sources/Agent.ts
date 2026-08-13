import type { SessionSystemMessage, SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import {
    AgentBase,
    type AgentBaseAwaitOptions,
    type AgentBaseMessageOptions,
    type AgentBaseOptions,
} from "./AgentBase.js";
import { agentKV, withAgentKV } from "./AgentContexts.js";
import type { AgentBaseHooks, MaybePromise } from "./AgentBaseHooks.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import type { AgentFeature } from "./AgentFeature.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

/**
 * Everything `AgentBase` is constructed with, except its hooks: an agent's behavior comes from
 * its features, and the singular hooks the base runs with are merged from them.
 */
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
    /** The session this agent is a facade over; every operation delegates straight to it. */
    readonly #base: AgentBase;
    /** The features whose hooks were merged into the base, kept in the order they were given. */
    readonly #features: readonly AgentFeature<Tool>[];

    /**
     * A new agent over a fresh identity, with its features' hooks merged into one set. Touches
     * no storage.
     */
    static async create<Tool extends AnyAgentTool = AnyAgentTool>(
        ctx: Context,
        options: AgentOptions<Tool>,
    ): Promise<Agent<Tool>> {
        const { features, base } = split(options);
        return new Agent(await AgentBase.create(ctx, base), features);
    }

    /**
     * An agent over an identity that may already have durable state, with that state's one
     * externally meaningful fact — whether it has work left — read before it is handed back.
     */
    static async load<Tool extends AnyAgentTool = AnyAgentTool>(
        ctx: Context,
        options: AgentOptions<Tool>,
    ): Promise<Agent<Tool>> {
        const { features, base } = split(options);
        return new Agent(await AgentBase.load(ctx, base), features);
    }

    /**
     * Wrap an already-built base. Private, because an agent is made by `create` or by `load`,
     * and which of the two the caller means is worth saying.
     */
    private constructor(base: AgentBase, features: readonly AgentFeature<Tool>[]) {
        this.#features = features;
        this.#base = base;
    }

    /** The stable session identity this agent was created with. */
    get id(): string {
        return this.#base.id;
    }

    /**
     * The feature this agent runs under `name`, when it has one. An individual feature holds the
     * state of the single agent it was built for, so this is how that agent's owner reaches what
     * belongs to it — a goal to pause, for instance. A shared feature is answered here too, but
     * it is the collection's instance, serving every agent at once.
     */
    feature(name: string): AgentFeature<Tool> | undefined {
        return this.#features.find((feature) => feature.name === name);
    }

    /**
     * The base's mutable instructions and tools, which every inference reads and every feature's
     * own contribution extends.
     */
    get state(): AgentBaseState {
        return this.#base.state;
    }

    /** Queue a user message that injects as soon as the current response and tool batch finish. */
    async steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#base.steer(ctx, message, options);
    }

    /** Queue a user message that injects only when the agent would otherwise stop. */
    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#base.send(ctx, message, options);
    }

    /** Start the loop without a new message, continuing a turn an earlier run left unfinished. */
    start(): void {
        this.#base.start();
    }

    /** Wait until the agent has nothing left to do, including work it accepted but never began. */
    async waitForIdle(): Promise<void> {
        await this.#base.waitForIdle();
    }

    /** Ask for the conversation to be replaced by the provider's summary of it. */
    async compact(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void> {
        await this.#base.compact(ctx, options);
    }

    /** Cancel the active turn, leaving queued messages durable for the next one. */
    async abort(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void> {
        await this.#base.abort(ctx, options);
    }

    /** Finish everything already accepted, then destroy the provider session. */
    async close(): Promise<void> {
        await this.#base.close();
    }
}

/**
 * Merge every feature's hook implementations into one `AgentBaseHooks`. A hook is provided only
 * when at least one feature implements it, so the base's own behavior — the mutable state alone
 * for instructions and tools — stays in effect otherwise.
 */
/**
 * Separate the features from the options the base is built with, and merge their hooks into the
 * one set the base observes the run through. Both factories need exactly this, and the merge has
 * to happen before the base exists.
 */
function split<Tool extends AnyAgentTool>(
    options: AgentOptions<Tool>,
): { features: readonly AgentFeature<Tool>[]; base: AgentBaseOptions } {
    const { features, ...rest } = options;
    const resolved = features ?? [];
    return { features: resolved, base: { ...rest, hooks: mergeFeatures(resolved) } };
}

function mergeFeatures<Tool extends AnyAgentTool>(
    features: readonly AgentFeature<Tool>[],
): AgentBaseHooks {
    const withInstructions = features.filter((feature) => feature.instructions !== undefined);
    const withTools = features.filter((feature) => feature.tools !== undefined);
    const withToolExecution = features.filter(
        (feature) => feature.aroundToolExecution !== undefined,
    );
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
    // Transactional hooks run in order inside one transaction, and a failure propagates: the
    // features here are writing alongside the fact being committed, so containing one feature's
    // failure would commit a conclusion the rest of the transaction contradicts.
    const chain = (
        pick: (feature: AgentFeature<Tool>) => ((ctx: Context) => MaybePromise<void>) | undefined,
    ): ((ctx: Context) => Promise<void>) | undefined => {
        const implemented = features.filter((feature) => pick(feature) !== undefined);
        if (implemented.length === 0) return undefined;
        return async (ctx) => {
            for (const feature of implemented) {
                await pick(feature)?.(featureCtx(ctx, feature));
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
        ...(withToolExecution.length === 0
            ? {}
            : {
                  // Correctness middleware: the first feature is the outermost wrapper, and a
                  // failure propagates to the base so it becomes this call's error result.
                  aroundToolExecution: async (ctx, execution) => {
                      const invoke = async (index: number): Promise<unknown> => {
                          const feature = withToolExecution[index];
                          if (feature === undefined) return await execution.execute();
                          let continued: Promise<unknown> | undefined;
                          return await feature.aroundToolExecution?.(featureCtx(ctx, feature), {
                              ...execution,
                              // A wrapper may inspect the continuation from more than one code
                              // path; every call joins the same downstream execution.
                              execute: () => (continued ??= invoke(index + 1)),
                          });
                      };
                      return await invoke(0);
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
            "afterAgentSettledTransact",
            chain((feature) => feature.afterAgentSettledTransact),
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
    const kv = agentKV(ctx);
    return kv === undefined ? ctx : withAgentKV(ctx, kv.scoped("feature", feature.name));
}

/**
 * One optional entry to spread into the merged hooks: the key when a merged implementation
 * exists, and nothing at all when no feature implemented it, so the base keeps its own behavior.
 */
function spread<Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [K in Key]?: Value } {
    return value === undefined ? {} : ({ [key]: value } as { [K in Key]: Value });
}
