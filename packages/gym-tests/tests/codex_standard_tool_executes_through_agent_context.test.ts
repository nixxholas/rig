import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Codex standard tool execution", () => {
    it("runs a shell tool through the shared agent context", async () => {
        const gym = await createGym({
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "gym-codex-token",
                        account_id: "gym-account",
                    },
                }),
            },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    const toolNames = request.context.tools?.map((tool) => tool.name) ?? [];
                    expect(toolNames).toContain("exec_command");
                    expect(toolNames).not.toContain("exec");
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "printf 'standard tool worked\\n' > standard-tool-result.txt",
                                    workdir: "/workspace",
                                },
                                id: "call-standard-tool",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(1);
                expect(request.context.messages.at(-1)).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                return {
                    content: [{ type: "text", text: "CODEX_STANDARD_TOOL_COMPLETE" }],
                };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex"],
        });
        running.add(gym);

        gym.terminal.type("Create the requested file with the shell tool.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("CODEX_STANDARD_TOOL_COMPLETE", 30_000);
        expect(screen.text).toContain("CODEX_STANDARD_TOOL_COMPLETE");
        await expect(gym.readFile("standard-tool-result.txt")).resolves.toBe(
            "standard tool worked\n",
        );
    }, 60_000);
});
