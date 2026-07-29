import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Auto reviewer uses the Codex Guardian contract", () => {
    it("accepts a Codex-shaped approval for an authorized dependency install", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    )
                ) {
                    expect(request.context.systemPrompt).toContain(
                        "dangerous or costly-to-reverse actions that pose a risk of irreversible damage",
                    );
                    expect(request.context.systemPrompt).not.toContain(
                        "executing untrusted downloads",
                    );
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    risk_level: "low",
                                    user_authorization: "medium",
                                    rationale:
                                        "Installing locked dependencies is routine local development.",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "printf 'dependencies installed\\n' > install-result.txt",
                                    justification:
                                        "Install the dependencies required for the requested implementation.",
                                    sandbox_permissions: "require_escalated",
                                    workdir: "/workspace",
                                },
                                id: "install-dependencies",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                return { content: [{ text: "INSTALL_COMPLETE", type: "text" }] };
            },
            permissionMode: "auto",
        });
        running.add(gym);

        gym.terminal.type("Implement the feature and install its locked dependencies.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("INSTALL_COMPLETE", 30_000);
        expect(screen.text).not.toContain("Automatic permission review refused");
        await expect(gym.readFile("install-result.txt")).resolves.toBe("dependencies installed\n");
    }, 120_000);
});
