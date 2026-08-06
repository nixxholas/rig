import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Auto reviewer uses the Codex Guardian contract", () => {
    it("accepts a medium-risk approval when long history is omitted", async () => {
        let reviewerMessages = "";
        const gym = await createGym({
            files: { "AGENTS_SECURITY.md": "" },
            inference(request, callIndex) {
                const messages = JSON.stringify(request.context.messages);
                if (messages.includes("<proposed_action>")) {
                    reviewerMessages = messages;
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    risk_level: "medium",
                                    user_authorization: "high",
                                    rationale:
                                        "The retained user request explicitly authorizes this bounded dependency install.",
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

        gym.terminal.paste(
            `${"Relevant implementation context.\n".repeat(260)}` +
                "Implement the feature and install its locked dependencies.",
        );
        await gym.terminal.waitForText("[paste #", 30_000);
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("INSTALL_COMPLETE", 30_000);
        expect(reviewerMessages).toContain("[Auto permission review has incomplete user evidence]");
        expect(screen.text).not.toContain("Automatic permission review refused");
        await expect(gym.readFile("install-result.txt")).resolves.toBe("dependencies installed\n");
    }, 120_000);
});
