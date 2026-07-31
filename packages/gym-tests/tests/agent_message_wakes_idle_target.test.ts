import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("agent message delivery to an idle target", () => {
    it("starts a new target turn without waiting for human input", async () => {
        let allowChildSend = () => {};
        const childMaySend = new Promise<void>((resolve) => {
            allowChildSend = resolve;
        });
        let reportParentWoke = () => {};
        const parentWoke = new Promise<void>((resolve) => {
            reportParentWoke = resolve;
        });
        let parentAgentId: string | undefined;
        let parentRunId: string | undefined;
        let childRunId: string | undefined;

        const gym = await createGym({
            inference: async (request) => {
                const runId = request.options.sessionId;
                if (runId === undefined) throw new Error("Expected a run ID.");
                const lastMessage = request.context.messages.at(-1);
                const serialized = JSON.stringify(lastMessage);
                const serializedContext = JSON.stringify(request.context.messages);

                if (
                    childRunId === undefined &&
                    lastMessage?.role === "user" &&
                    serialized.includes("Wake the idle parent using its exact agent ID")
                ) {
                    childRunId = runId;
                    return {
                        content: [
                            {
                                arguments: { agent_id: parentAgentId },
                                id: "inspect-idle-parent",
                                name: "agent_info",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (
                    runId === childRunId &&
                    lastMessage?.role === "toolResult" &&
                    lastMessage.toolName === "agent_info"
                ) {
                    await childMaySend;
                    return {
                        content: [
                            {
                                arguments: {
                                    agent_id: parentAgentId,
                                    message: "WAKE_IDLE_PARENT",
                                },
                                id: "wake-idle-parent",
                                name: "agent_send",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (
                    runId === childRunId &&
                    lastMessage?.role === "toolResult" &&
                    lastMessage.toolName === "agent_send"
                ) {
                    await parentWoke;
                    return {
                        content: [{ text: "CHILD_CONFIRMED_PARENT_WOKE", type: "text" }],
                    };
                }

                if (serializedContext.includes("WAKE_IDLE_PARENT")) {
                    expect(runId).not.toBe(childRunId);
                    reportParentWoke();
                    return {
                        content: [{ text: "IDLE_PARENT_WOKE_UP", type: "text" }],
                    };
                }

                parentRunId ??= runId;
                expect(runId).toBe(parentRunId);

                if (lastMessage?.role === "toolResult" && lastMessage.toolName === "agent_me") {
                    const content = lastMessage.content[0];
                    if (
                        typeof content !== "object" ||
                        content === null ||
                        content.type !== "text"
                    ) {
                        throw new Error("agent_me returned no text.");
                    }
                    parentAgentId = (JSON.parse(content.text) as { agentId: string }).agentId;
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "none",
                                    message: `Wake the idle parent using its exact agent ID ${parentAgentId}.`,
                                    model: "openai/gym",
                                    reasoning_effort: "medium",
                                    task_name: "wake_idle_parent",
                                },
                                id: "spawn-wakeup-agent",
                                name: "spawn_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (lastMessage?.role === "toolResult" && lastMessage.toolName === "spawn_agent") {
                    return {
                        content: [{ text: "PARENT_IS_IDLE", type: "text" }],
                    };
                }

                expect(lastMessage).toMatchObject({ role: "user" });
                return {
                    content: [
                        {
                            arguments: {},
                            id: "identify-parent",
                            name: "agent_me",
                            type: "toolCall",
                        },
                    ],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Start a child that will message this chat after it becomes idle.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("PARENT_IS_IDLE");
        allowChildSend();

        const screen = await gym.terminal.waitForText("IDLE_PARENT_WOKE_UP", 15_000);
        expect(screen.text).toContain("IDLE_PARENT_WOKE_UP");
        expect(
            gym.inference.requests.some((request) => {
                const lastMessage = request.context.messages.at(-1);
                return JSON.stringify(lastMessage).includes("WAKE_IDLE_PARENT");
            }),
        ).toBe(true);
    });
});
