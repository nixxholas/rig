import { describe, expect, it } from "vitest";

import { selectCommonToolsForModel } from "./selectCommonToolsForModel.js";

describe("selectCommonToolsForModel", () => {
    it("gives primary agents all scheduling tools", () => {
        expect(selectCommonToolsForModel({ isSubagent: false }).map((tool) => tool.name)).toEqual([
            "wait",
            "wait_until",
            "schedule_message",
            "get_provider_usage",
        ]);
    });

    it("never gives schedule_message to subagents", () => {
        expect(selectCommonToolsForModel({ isSubagent: true }).map((tool) => tool.name)).toEqual([
            "wait",
            "wait_until",
            "get_provider_usage",
        ]);
    });
});
