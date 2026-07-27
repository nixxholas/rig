import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("agent identity and exact-id steering", () => {
    it("uses agent_me output as the capability for agent_send and receives reply instructions", async () => {
        let ownAgentId: string | undefined;
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {},
                                id: "identify-agent",
                                name: "agent_me",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (callIndex === 1) {
                    const result = request.context.messages.at(-1);
                    expect(result).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "agent_me",
                    });
                    const content = result?.content[0];
                    expect(content).toMatchObject({ type: "text" });
                    if (
                        typeof content !== "object" ||
                        content === null ||
                        content.type !== "text"
                    ) {
                        throw new Error("agent_me returned no text.");
                    }
                    const identity = JSON.parse(content.text) as {
                        agentId: string;
                    };
                    ownAgentId = identity.agentId;
                    return {
                        content: [
                            {
                                arguments: { agent_id: identity.agentId },
                                id: "inspect-agent",
                                name: "agent_info",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (callIndex === 2) {
                    const result = request.context.messages.at(-1);
                    expect(result).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "agent_info",
                    });
                    const content = result?.content[0];
                    expect(content).toMatchObject({ type: "text" });
                    if (
                        typeof content !== "object" ||
                        content === null ||
                        content.type !== "text"
                    ) {
                        throw new Error("agent_info returned no text.");
                    }
                    const info = JSON.parse(content.text) as {
                        agentId: string;
                        diskShared: boolean;
                        path?: string;
                    };
                    expect(info).toMatchObject({
                        agentId: ownAgentId,
                        diskShared: true,
                    });
                    expect(info.path).toContain("rig-gym-");
                    return {
                        content: [
                            {
                                arguments: {
                                    agent_id: ownAgentId,
                                    message: "Self-steering probe",
                                },
                                id: "send-to-agent",
                                name: "agent_send",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(ownAgentId).toBeDefined();
                const steering = request.context.messages.at(-1);
                expect(steering).toMatchObject({ role: "user" });
                const serializedSteering = JSON.stringify(steering);
                expect(serializedSteering).toContain("Self-steering probe");
                expect(serializedSteering).toContain(`Sender agent ID: \\"${ownAgentId}\\"`);
                expect(serializedSteering).toContain(
                    `first call agent_info with agent_id \\"${ownAgentId}\\"`,
                );
                return {
                    content: [{ text: "Exact-ID steering received.", type: "text" }],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Identify yourself, then send yourself a steering message.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("Exact-ID steering received.");
        expect(screen.text).toContain("Sent a steering message to another agent.");
    });
});
