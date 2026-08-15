import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    HappyModule,
    type HappyHost,
    type HappyModuleOptions,
} from "../../sources/happy/index.js";

const ctx = createRootContext().named("happy-module-test");

function host(): HappyHost {
    return {
        notify: async () => ({ accepted: true }),
        setStatus: async () => ({ accepted: true }),
    };
}

function transaction(): HappyModuleOptions["transaction"] {
    return async (_ctx, work) => await work(ctx, {} as never);
}

describe("HappyModule", () => {
    it("owns the stable module name, migration, and client-facing tools", () => {
        const module = new HappyModule({ host: host(), transaction: transaction() });
        expect(module.name).toBe("happy");
        expect(module.migrations?.map(([key]) => key)).toEqual(["001-happy-state"]);
        expect(
            module.tools(ctx, {
                agent: { id: "agent-a", permissionMode: "auto" },
            } as never).map((tool) => tool.name),
        ).toEqual(["notify_happy", "set_happy_status", "get_happy_status"]);
    });

    it("rejects a host that does not expose the complete transport boundary", () => {
        expect(
            () =>
                new HappyModule({
                    host: { notify: async () => ({ accepted: true }) } as never,
                    transaction: transaction(),
                }),
        ).toThrow("Happy module options are invalid");
    });
});