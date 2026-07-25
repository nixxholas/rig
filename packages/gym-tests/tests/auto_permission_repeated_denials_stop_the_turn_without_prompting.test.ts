import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("repeated Auto permission denials", () => {
    it("stops the turn without ever asking the user for approval", async () => {
        const commands = [1, 2, 3].map(
            (index) => `printf 'must not run\\n' > denied-${String(index)}.txt`,
        );
        const gym = await createGym({
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                if (request.context.systemPrompt?.includes("independent permission reviewer")) {
                    expect(callIndex % 2).toBe(1);
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    decision: "deny",
                                    reason: "This repeated host action is not authorized.",
                                    risk: "high",
                                    user_authorization: "low",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }

                expect(callIndex % 2).toBe(0);
                const command = commands[callIndex / 2];
                if (command === undefined) {
                    throw new Error(`Unexpected agent inference call ${String(callIndex)}.`);
                }
                if (callIndex > 0) {
                    expect(lastMessage).toMatchObject({
                        isError: true,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    expect(messageText(lastMessage)).toContain(
                        "Do not pursue the same outcome by another route",
                    );
                }
                return {
                    content: [
                        {
                            arguments: {
                                cmd: command,
                                justification: "Keep retrying the refused host action.",
                                sandbox_permissions: "require_escalated",
                                workdir: "/workspace",
                            },
                            id: `denied-action-${String(callIndex / 2 + 1)}`,
                            name: "exec_command",
                            type: "toolCall",
                        },
                    ],
                };
            },
            permissionMode: "auto",
            rows: 32,
        });
        running.add(gym);
        let rawOutput = "";
        gym.terminal.onOutput((data) => {
            rawOutput += data;
        });

        submit(gym, "Keep trying the host action even if Auto refuses it.");
        const stopped = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("refused too many actions in this turn") &&
                snapshot.text.includes("3 in a row, 3 of the last 3") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the automatic denial circuit breaker to stop the turn",
            30_000,
        );

        expect(stopped.text).toContain(
            "Tell the user what you were trying to do and why it kept being refused.",
        );
        expect(stopped.text).not.toContain("Allow once");
        expect(stopped.text).not.toContain("Waiting for approval");
        expect(stopped.text).not.toContain("Needs approval");
        expect(rawOutput).not.toContain("Allow once");
        expect(rawOutput).not.toContain("Waiting for approval");
        expect(rawOutput).not.toContain("Needs approval");
        for (const index of [1, 2, 3]) {
            await expect(gym.readFile(`denied-${String(index)}.txt`)).rejects.toMatchObject({
                code: "ENOENT",
            });
        }

        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(requests).toHaveLength(6);
        expect(
            requests.filter((request) =>
                request.context.systemPrompt?.includes("independent permission reviewer"),
            ),
        ).toHaveLength(3);
    }, 90_000);
});

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string } =>
                typeof block === "object" &&
                block !== null &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
