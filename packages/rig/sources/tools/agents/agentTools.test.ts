import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { agentInfoTool } from "./agent_info.js";
import { agentMeTool } from "./agent_me.js";
import { agentSendTool } from "./agent_send.js";

describe("agent communication tools", () => {
    it("returns only the current agent identity and sends by exact agent id", async () => {
        const harness = createJustBashToolHarness();
        const send = vi.fn(() => ({ delivered: true as const }));
        const setReadOnly = vi.fn(async () => {});
        harness.context.agentCommunication = {
            info: (agentId) => ({
                agentId,
                diskShared: false,
                folder: "target",
                notice: "This agent's disk is not shared with yours.",
                title: "Review authentication",
            }),
            me: () => ({
                agentId: "sender-agent-id",
                folder: "sender",
                title: "Fix authentication",
            }),
            send,
            setReadOnly,
        };

        await expect(harness.runTool(agentMeTool, {})).resolves.toEqual({
            agentId: "sender-agent-id",
            title: "Fix authentication",
        });
        expect(
            agentMeTool.toLLM({
                agentId: "sender-agent-id",
                title: "Fix authentication",
            }),
        ).toContainEqual({
            type: "text",
            text: "You may forward this agent ID and title to the human so they can share the ID with another agent to connect them.",
        });
        await expect(
            harness.runTool(agentInfoTool, { agent_id: "target-agent-id" }),
        ).resolves.toEqual({
            agentId: "target-agent-id",
            diskShared: false,
            notice: "This agent's disk is not shared with yours.",
            title: "Review authentication",
        });
        expect(
            agentInfoTool.toLLM({
                agentId: "target-agent-id",
                diskShared: false,
                notice: "This agent's disk is not shared with yours.",
                title: "Review authentication",
            }),
        ).toContainEqual({
            type: "text",
            text: 'You can now send this agent a message with agent_send using agent_id "target-agent-id". Its disk is not shared with yours, so you cannot access its folder.',
        });
        expect(
            agentInfoTool.toLLM({
                agentId: "shared-agent-id",
                diskShared: true,
                folder: "shared-agent",
                path: "/workspaces/shared-agent",
                title: "Shared agent",
            }),
        ).toContainEqual({
            type: "text",
            text: 'You can now send this agent a message with agent_send using agent_id "shared-agent-id". Its disk is shared with yours; its folder is available at "/workspaces/shared-agent".',
        });
        await expect(
            harness.runTool(agentSendTool, {
                agent_id: "target-agent-id",
                message: "Please review the change.",
            }),
        ).resolves.toEqual({ delivered: true });
        expect(send).toHaveBeenCalledWith("target-agent-id", "Please review the change.");
        await expect(
            harness.runTool(agentSendTool, {
                agent_id: "target-agent-id",
                message: "You may edit now.",
                read_only: false,
            }),
        ).resolves.toEqual({ delivered: true });
        expect(setReadOnly).toHaveBeenCalledWith("target-agent-id", false);
        expect(send).toHaveBeenLastCalledWith("target-agent-id", "You may edit now.");
        expect(agentSendTool.shouldReviewInAutoMode?.({} as never, harness.context)).toBe(false);
    });
});
