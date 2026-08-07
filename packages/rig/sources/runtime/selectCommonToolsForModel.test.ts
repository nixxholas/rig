import { describe, expect, it } from "vitest";

import { selectCommonToolsForModel } from "./selectCommonToolsForModel.js";

describe("selectCommonToolsForModel", () => {
    it("gives primary agents all scheduling tools", () => {
        expect(
            selectCommonToolsForModel({ hasWorkspaceContext: true, isSubagent: false }).map(
                (tool) => tool.name,
            ),
        ).toEqual([
            "attach",
            "transfer_session",
            "wait",
            "wait_until",
            "schedule_message",
            "cancel_ask",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "applet_create",
            "applet_update",
            "applet_revert",
            "applet_list",
        ]);
    });

    it("never gives schedule_message to subagents", () => {
        expect(
            selectCommonToolsForModel({ hasWorkspaceContext: true, isSubagent: true }).map(
                (tool) => tool.name,
            ),
        ).toEqual([
            "attach",
            "wait",
            "wait_until",
            "get_agent_tree_usage",
            "get_provider_usage",
            "plugin_discover",
            "plugin_install",
            "plugin_uninstall",
            "plugin_list",
            "plugin_logs",
            "slot_create",
            "slot_update",
            "slot_remove",
            "slot_list",
            "applet_create",
            "applet_update",
            "applet_revert",
            "applet_list",
        ]);
    });

    it("never gives transfer_session to a session without workspace context", () => {
        expect(
            selectCommonToolsForModel({ hasWorkspaceContext: false, isSubagent: false }).map(
                (tool) => tool.name,
            ),
        ).not.toContain("transfer_session");
    });
});
