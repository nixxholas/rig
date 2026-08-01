import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("durable state and daemon control paths", () => {
    it("keeps internal state hidden and daemon control files temporary", async () => {
        const gym = await createGym({
            mode: "docker",
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                cmd: [
                                    "state=/home/rig/.happy/rig",
                                    "config=/home/rig/happy/config",
                                    'test -f "$state/sessions.sqlite"',
                                    'test ! -e "$state/happy.toml"',
                                    'test -f "$config/happy.toml"',
                                    'test -f "$config/AGENTS.md"',
                                    'test -f "$config/SECURITY.md"',
                                    'test -S "/tmp/rig-$(id -u)/server.sock"',
                                    'test ! -e "/home/rig/.server/sessions.sqlite"',
                                    "printf 'Rig state and daemon control paths are correct.\\n'",
                                ].join(" && "),
                            },
                            id: "verify-default-state-paths",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "Default state paths verified.", type: "text" }] },
            ],
        });
        running.add(gym);

        gym.terminal.type("Verify the default state and daemon control paths.");
        gym.terminal.press("enter");

        const snapshot = await gym.terminal.waitForText("Default state paths verified.", 30_000);
        expect(snapshot.text).toContain("Rig state and daemon control paths are correct.");
        expect(lastAgentRequest(gym).context.messages.at(-1)).toMatchObject({
            isError: false,
            role: "toolResult",
            toolName: "exec_command",
        });
    }, 120_000);

    it("uses RIG_HOME only for durable state", async () => {
        const gym = await createGym({
            environment: { RIG_HOME: "/home/rig/custom-rig-home" },
            mode: "docker",
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                cmd: [
                                    "state=/home/rig/custom-rig-home",
                                    "config=/home/rig/happy/config",
                                    'test -f "$state/sessions.sqlite"',
                                    'test ! -e "$state/happy.toml"',
                                    'test -f "$config/happy.toml"',
                                    'test -f "$config/AGENTS.md"',
                                    'test -f "$config/SECURITY.md"',
                                    'test ! -e "/home/rig/.happy/rig/sessions.sqlite"',
                                    'test -S "/tmp/rig-$(id -u)/server.sock"',
                                    "printf 'RIG_HOME controls only durable state.\\n'",
                                ].join(" && "),
                            },
                            id: "verify-custom-state-paths",
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "Custom state path verified.", type: "text" }] },
            ],
        });
        running.add(gym);

        gym.terminal.type("Verify the custom durable state path.");
        gym.terminal.press("enter");

        const snapshot = await gym.terminal.waitForText("Custom state path verified.", 30_000);
        expect(snapshot.text).toContain("RIG_HOME controls only durable state.");
        expect(lastAgentRequest(gym).context.messages.at(-1)).toMatchObject({
            isError: false,
            role: "toolResult",
            toolName: "exec_command",
        });
    }, 120_000);
});

function lastAgentRequest(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    )[1]!;
}
