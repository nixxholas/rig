import type { AgentModuleAgent, AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AutoReviewComputeModule } from "../../sources/auto/impl/AutoReviewComputeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const context: Context = createRootContext().named("auto-review-compute-test");

function scope(): AgentModuleScope {
    const agent: AgentModuleAgent = {
        id: "reviewer",
        metadata: undefined,
        model: "openai/codex-auto-review",
        provider: "codex",
        providerKind: "codex",
        effort: "low",
        permissionMode: "read_only",
        tier: undefined,
    };
    return { agent } as AgentModuleScope;
}

describe("AutoReviewComputeModule", () => {
    it("exposes exactly the host-provided read-only tools", async () => {
        const tools = [
            { name: "read_file", namespace: "codex" },
            { name: "list_dir", namespace: "codex" },
        ] as unknown as readonly AnyAgentTool[];
        const seenScopes: AgentModuleScope[] = [];
        const module = new AutoReviewComputeModule((received) => {
            seenScopes.push(received);
            return tools;
        });
        const hooks = await resolveModuleHooks(context, module);

        const received = hooks.tools?.(context, scope());

        expect(received).toBe(tools);
        expect(seenScopes).toHaveLength(1);
        expect(seenScopes[0]?.agent.id).toBe("reviewer");
    });

    it("invokes the builder for each request rather than caching a mutable tool array", async () => {
        const first = [{ name: "first" }] as unknown as readonly AnyAgentTool[];
        const second = [{ name: "second" }] as unknown as readonly AnyAgentTool[];
        let calls = 0;
        const module = new AutoReviewComputeModule(() => {
            calls += 1;
            return calls === 1 ? first : second;
        });
        const hooks = await resolveModuleHooks(context, module);
        const reviewerScope = scope();

        expect(hooks.tools?.(context, reviewerScope)).toBe(first);
        expect(hooks.tools?.(context, reviewerScope)).toBe(second);
        expect(calls).toBe(2);
    });

    it("lets a host builder failure propagate as a correctness-hook failure", async () => {
        const module = new AutoReviewComputeModule(() => {
            throw new Error("tool catalog unavailable");
        });
        const hooks = await resolveModuleHooks(context, module);

        expect(() => hooks.tools?.(context, scope())).toThrow("tool catalog unavailable");
    });
});
