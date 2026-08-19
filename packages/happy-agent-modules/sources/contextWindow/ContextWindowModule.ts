import type {
    AgentBaseTurn,
    AgentModule,
    AgentModuleAction,
    AgentModuleHooks,
    AgentModuleScope,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";

/** Schedules provider compaction before a measured conversation reaches its hard model limit. */
export class ContextWindowModule implements AgentModule {
    readonly name = "contextWindow";

    constructor(private readonly config: ConfigModule) {}

    readonly beforeStart = (): AgentModuleHooks => ({
        afterTurn: (
            _ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurn,
        ): readonly AgentModuleAction[] | undefined => {
            if (
                turn.aborted ||
                turn.contextTokens === undefined ||
                scope.agent.model === undefined
            ) {
                return undefined;
            }
            const context = this.config.modelContext(scope.agent.provider, scope.agent.model);
            if (context === undefined || turn.contextTokens < context.autoCompactWindow) {
                return undefined;
            }
            return [{ type: "compact" }];
        },
    });
}
