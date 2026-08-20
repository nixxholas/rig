import type {
    AgentBaseInference,
    AgentBaseTurnStart,
    AgentModule,
    AgentModuleAction,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";

/** Schedules compaction before another inference can exceed the model's curated context limit. */
export class ContextWindowModule implements AgentModule {
    readonly name = "contextWindow";

    constructor(private readonly config: ConfigModule) {}

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => ({
        beforeTurn: (
            _ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurnStart,
        ): readonly AgentModuleAction[] | undefined =>
            this.#compactionAction(scope, turn.contextTokens),
        afterInference: async (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): Promise<void> => {
            if (inference.tokens === undefined) return;
            const contextTokens = inference.tokens.input + inference.tokens.output;
            if (this.#compactionAction(scope, contextTokens) === undefined) return;
            await agents.compact(ctx, scope.agent.id);
        },
    });

    #compactionAction(
        scope: AgentModuleScope,
        contextTokens: number | undefined,
    ): readonly AgentModuleAction[] | undefined {
        if (contextTokens === undefined || scope.agent.model === undefined) return undefined;
        const context = this.config.modelContext(scope.agent.provider, scope.agent.model);
        if (context === undefined || contextTokens < context.autoCompactWindow) return undefined;
        return [{ type: "compact" }];
    }
}
