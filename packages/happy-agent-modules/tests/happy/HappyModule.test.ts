import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { HappyModule, type HappyHost } from "../../sources/happy/index.js";

const ctx = createRootContext().named("happy-module-test");

function host(): HappyHost {
    return {
        notify: async () => ({ accepted: true }),
        setStatus: async () => ({ accepted: true }),
    };
}

describe("HappyModule", () => {
    it("owns the stable module name, migration, and client-facing tools", () => {
        const module = new HappyModule({ host: host() });
        expect(module.name).toBe("happy");
        expect(module.migrations?.map(([key]) => key)).toEqual(["001-happy-state"]);
        const tools = module.tools(ctx, {
            agent: { id: "agent-a", permissionMode: "auto" },
        } as never);
        expect(tools.map((tool) => tool.name)).toEqual([
            "notify_happy",
            "set_happy_status",
            "get_happy_status",
        ]);
        expect(tools.map((tool) => tool.transactional ?? false)).toEqual([true, true, false]);
    });

    it("rejects a host that does not expose the complete transport boundary", () => {
        expect(
            () =>
                new HappyModule({
                    host: { notify: async () => ({ accepted: true }) } as never,
                }),
        ).toThrow("Happy module options are invalid");
    });
});
