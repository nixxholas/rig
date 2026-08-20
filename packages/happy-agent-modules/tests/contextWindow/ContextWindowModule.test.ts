import type {
    AgentBaseInference,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { ContextWindowModule } from "../../sources/contextWindow/index.js";

const ctx = createRootContext().named("context-window-module-test");
const scope = {
    agent: {
        id: "agent-1",
        model: "model-1",
        provider: "provider-1",
    },
} as AgentModuleScope;

describe("ContextWindowModule", () => {
    it("checks restored turns and every measured inference against the model threshold", async () => {
        const config = {
            modelContext: () => ({ autoCompactWindow: 750, contextWindow: 1_000 }),
        } as unknown as ConfigModule;
        const compact = vi.fn(() => Promise.resolve());
        const agents = { compact } as unknown as AgentSystemRef;
        const hooks = await new ContextWindowModule(config).beforeStart?.(ctx, agents);
        if (hooks === undefined) throw new Error("The context-window hooks did not start.");

        expect(
            await hooks.beforeTurn?.(ctx, scope, {
                contextTokens: 800,
                loopId: "loop-1",
                turnId: "turn-1",
            }),
        ).toEqual([{ type: "compact" }]);

        const inference: AgentBaseInference = {
            contextTokens: 700,
            inferenceId: "inference-1",
            loopId: "loop-1",
            state: "tool_call",
            tokens: { input: 700, output: 50 },
            turnId: "turn-1",
        };
        await hooks.afterInference?.(ctx, scope, inference);

        expect(compact).toHaveBeenCalledOnce();
        expect(compact).toHaveBeenCalledWith(ctx, "agent-1");
    });
});
