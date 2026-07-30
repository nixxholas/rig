import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("managed shell network in the Linux sandbox", () => {
    it("starts the command through the isolated proxy bridge", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "printf NETWORK_COMMAND_RAN > marker.txt",
                                },
                                id: "managed-network-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                const result = request.context.messages.at(-1);
                expect(result).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                return {
                    content: [{ text: "MANAGED_NETWORK_BRIDGE_READY", type: "text" }],
                };
            },
            files: {
                "rig.toml": '[network]\nallowed_domains = ["example.com"]\n',
            },
            mode: "docker",
            permissionMode: "workspace_write",
        });
        running.add(gym);

        gym.terminal.type("Run the networked command.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("MANAGED_NETWORK_BRIDGE_READY", 30_000);
        await expect(gym.readFile("marker.txt")).resolves.toBe("NETWORK_COMMAND_RAN");
    }, 120_000);
});
