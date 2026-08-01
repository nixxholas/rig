import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("subagent read-only mode", () => {
    it("blocks writes at spawn and restores the parent mode with a follow-up message", async () => {
        let childSessionId: string | undefined;
        const patch = [
            "*** Begin Patch",
            "*** Add File: child-proof.txt",
            "+written after permission switch",
            "*** End Patch",
        ].join("\n");
        const gym = await createGym({
            inference(request) {
                const sessionId = request.options.sessionId;
                expect(sessionId).toBeTypeOf("string");
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    ) === true
                ) {
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    rationale:
                                        "The parent explicitly restored Auto mode before this workspace write.",
                                    risk_level: "low",
                                    user_authorization: "high",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }
                if (sessionId?.endsWith(":title")) {
                    return { content: [{ text: "Subagent permission switch", type: "text" }] };
                }
                const lastMessage = request.context.messages.at(-1);
                const lastText = messageText(lastMessage);

                if (lastText.includes("Start one read-only child.")) {
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "none",
                                    message:
                                        "Try to write child-proof.txt, then report the result.",
                                    model: "openai/gym",
                                    read_only: true,
                                    reasoning_effort: "medium",
                                    task_name: "inspect_only",
                                },
                                id: "spawn-read-only-child",
                                name: "spawn_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (
                    sessionId === childSessionId ||
                    lastText.includes("Try to write child-proof.txt") ||
                    lastText.includes("Write child-proof.txt now")
                ) {
                    childSessionId = sessionId;
                    if (
                        lastText.includes("Try to write child-proof.txt") ||
                        lastText.includes("Write child-proof.txt now")
                    ) {
                        return {
                            content: [
                                {
                                    arguments: { patch, workdir: "/workspace" },
                                    id: lastText.includes("Try to write")
                                        ? "blocked-child-write"
                                        : "allowed-child-write",
                                    name: "apply_patch",
                                    type: "toolCall",
                                },
                            ],
                        };
                    }
                    if (lastMessage?.role === "toolResult") {
                        if (lastMessage.isError) {
                            expect(lastText).toContain(
                                "File changes are disabled in read-only mode.",
                            );
                            return {
                                content: [{ text: "CHILD_CONFIRMED_READ_ONLY", type: "text" }],
                            };
                        }
                        expect(lastText).toContain("child-proof.txt");
                        return { content: [{ text: "CHILD_CONFIRMED_WRITE", type: "text" }] };
                    }
                }

                if (lastText.includes("Let the retained child edit now.")) {
                    return {
                        content: [
                            {
                                arguments: {
                                    message: "Write child-proof.txt now.",
                                    read_only: false,
                                    target: "inspect_only",
                                },
                                id: "restore-child-mode",
                                name: "followup_task",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (lastText.includes("CHILD_CONFIRMED_WRITE")) {
                    return { content: [{ text: "PARENT_NOTED_CHILD_WRITE", type: "text" }] };
                }
                if (lastText.includes("CHILD_CONFIRMED_READ_ONLY")) {
                    return { content: [{ text: "PARENT_NOTED_READ_ONLY", type: "text" }] };
                }
                if (lastMessage?.role === "toolResult") {
                    return { content: [{ text: "PARENT_SENT_CHILD_MESSAGE", type: "text" }] };
                }
                return { content: [{ text: "PARENT_IDLE", type: "text" }] };
            },
            mode: "docker",
            permissionMode: "auto",
            rows: 30,
        });
        running.add(gym);

        submit(gym, "Start one read-only child.");
        await gym.terminal.waitForText("PARENT_NOTED_READ_ONLY", 30_000);
        await expect(gym.readFile("child-proof.txt")).rejects.toThrow();

        submit(gym, "Let the retained child edit now.");
        const completed = await gym.terminal.waitForText("PARENT_NOTED_CHILD_WRITE", 30_000);

        expect(completed.text).not.toContain("Automatic permission review");
        await expect(gym.readFile("child-proof.txt")).resolves.toBe(
            "written after permission switch",
        );
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function messageText(message: { content?: unknown } | undefined): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block): block is { text: string; type: "text" } => block.type === "text")
        .map((block) => block.text)
        .join("");
}
