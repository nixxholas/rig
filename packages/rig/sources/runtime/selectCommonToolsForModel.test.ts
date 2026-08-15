import { describe, expect, it } from "vitest";

import { selectCommonToolsForModel } from "./selectCommonToolsForModel.js";

describe("selectCommonToolsForModel", () => {
    it("gives primary agents all scheduling tools", () => {
        expect(
            selectCommonToolsForModel({
                hasFolderContext: false,
                hasWorkspaceContext: true,
                isSubagent: false,
            }).map((tool) => tool.name),
        ).toEqual([
            "attach",
            "request_secret",
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
            "worklet_install",
            "worklet_update",
            "worklet_revert",
            "worklet_uninstall",
            "worklet_list",
            "worklet_logs",
        ]);
    });

    it("never gives schedule_message to subagents", () => {
        expect(
            selectCommonToolsForModel({
                hasFolderContext: false,
                hasWorkspaceContext: true,
                isSubagent: true,
            }).map((tool) => tool.name),
        ).toEqual([
            "attach",
            "request_secret",
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
            "worklet_install",
            "worklet_update",
            "worklet_revert",
            "worklet_uninstall",
            "worklet_list",
            "worklet_logs",
        ]);
    });

    it("never gives transfer_session to a session without workspace context", () => {
        expect(
            selectCommonToolsForModel({
                hasFolderContext: false,
                hasWorkspaceContext: false,
                isSubagent: false,
            }).map((tool) => tool.name),
        ).not.toContain("transfer_session");
    });

    it("gives folder tools to a session that can reach the folder tree", () => {
        expect(
            selectCommonToolsForModel({
                hasFolderContext: true,
                hasWorkspaceContext: true,
                isSubagent: false,
            }).map((tool) => tool.name),
        ).toEqual(
            expect.arrayContaining([
                "create_folder",
                "list_folders",
                "update_folder",
                "move_folder",
                "set_chat_folder",
            ]),
        );
    });

    it("keeps folder tools away from a session without folders", () => {
        expect(
            selectCommonToolsForModel({
                hasFolderContext: false,
                hasWorkspaceContext: true,
                isSubagent: false,
            }).map((tool) => tool.name),
        ).not.toContain("create_folder");
    });
});
