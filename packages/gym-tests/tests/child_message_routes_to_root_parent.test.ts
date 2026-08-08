import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("child message delivery to its root parent", () => {
    it("resolves /root and wakes the direct parent", async () => {
        let allowChildSend = () => {};
        const childMaySend = new Promise<void>((resolve) => {
            allowChildSend = resolve;
        });
        let reportParentWoke = () => {};
        const parentWoke = new Promise<void>((resolve) => {
            reportParentWoke = resolve;
        });
        let parentRunId: string | undefined;
        let childRunId: string | undefined;

        const gym = await createGym({
            inference: async (request) => {
                const runId = request.options.sessionId;
                if (runId === undefined) throw new Error("Expected a run ID.");
                const lastMessage = request.context.messages.at(-1);
                const serializedContext = JSON.stringify(request.context.messages);

                if (
                    childRunId === undefined &&
                    lastMessage?.role === "user" &&
                    serializedContext.includes(
                        "Send CHILD_TO_ROOT_MESSAGE to your direct parent at /root.",
                    )
                ) {
                    childRunId = runId;
                    await childMaySend;
                    return {
                        content: [
                            {
                                arguments: {
                                    message: "CHILD_TO_ROOT_MESSAGE",
                                    target: "/root",
                                },
                                id: "message-root-parent",
                                name: "send_message",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (
                    runId === childRunId &&
                    lastMessage?.role === "toolResult" &&
                    lastMessage.toolName === "send_message"
                ) {
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "send_message",
                    });
                    await parentWoke;
                    return {
                        content: [{ text: "CHILD_CONFIRMED_ROOT_WOKE", type: "text" }],
                    };
                }

                if (runId !== childRunId && serializedContext.includes("CHILD_TO_ROOT_MESSAGE")) {
                    reportParentWoke();
                    return {
                        content: [{ text: "ROOT_RECEIVED_CHILD_MESSAGE", type: "text" }],
                    };
                }

                parentRunId ??= runId;
                expect(runId).toBe(parentRunId);

                if (lastMessage?.role === "toolResult" && lastMessage.toolName === "spawn_agent") {
                    return {
                        content: [{ text: "ROOT_IS_IDLE", type: "text" }],
                    };
                }

                expect(lastMessage).toMatchObject({ role: "user" });
                return {
                    content: [
                        {
                            arguments: {
                                fork_turns: "none",
                                message:
                                    "Send CHILD_TO_ROOT_MESSAGE to your direct parent at /root.",
                                model: "openai/gym",
                                reasoning_effort: "medium",
                                task_name: "report_to_root",
                            },
                            id: "spawn-root-reporter",
                            name: "spawn_agent",
                            namespace: "collaboration",
                            type: "toolCall",
                        },
                    ],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Start a child that will message this chat after it becomes idle.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("ROOT_IS_IDLE");
        allowChildSend();

        const screen = await gym.terminal.waitForText("ROOT_RECEIVED_CHILD_MESSAGE", 15_000);
        expect(screen.text).toContain("ROOT_RECEIVED_CHILD_MESSAGE");
        expect(screen.text).not.toContain("Subagent '/root' was not found.");
        expect(
            gym.inference.requests.some((request) => {
                const lastMessage = request.context.messages.at(-1);
                return (
                    request.options.sessionId === parentRunId &&
                    JSON.stringify(lastMessage).includes("CHILD_TO_ROOT_MESSAGE")
                );
            }),
        ).toBe(true);
    });
});
