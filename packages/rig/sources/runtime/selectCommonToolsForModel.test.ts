import { describe, expect, it } from "vitest";

import { selectCommonToolsForModel } from "./selectCommonToolsForModel.js";

describe("selectCommonToolsForModel", () => {
    it("gives primary agents all scheduling tools", () => {
        expect(selectCommonToolsForModel({ isSubagent: false }).map((tool) => tool.name)).toEqual([
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
        ]);
    });

    it("never gives schedule_message to subagents", () => {
        expect(selectCommonToolsForModel({ isSubagent: true }).map((tool) => tool.name)).toEqual([
            "wait",
            "wait_until",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
        ]);
    });
});
