import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("cross-provider fork context accounting", () => {
    it("starts a Fable child without compacting a projected Codex checkpoint", async () => {
        let parentSessionId: string | undefined;
        let childCompactionSeen = false;
        let childInferenceSeen = false;
        const gym = await createGym({
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "gym-codex-token",
                        account_id: "gym-account",
                    },
                }),
            },
            inference(request) {
                const sessionId = request.options.sessionId;
                if (sessionId?.endsWith(":title") === true) {
                    return { content: [{ text: "Fork checkpoint regression", type: "text" }] };
                }
                if (request.providerId === "claude") {
                    if (request.options.intent === "compaction") {
                        childCompactionSeen = true;
                        return {
                            compactionContext: {
                                ...request.context,
                                messages: [
                                    {
                                        role: "user",
                                        content: "Unexpected child compaction.",
                                        timestamp: 1,
                                    },
                                ],
                            },
                            content: [],
                        };
                    }
                    childInferenceSeen = true;
                    expect(JSON.stringify(request.context.messages)).toContain(
                        "PARENT_CHECKPOINT_CONTEXT",
                    );
                    return {
                        content: [{ text: "CHILD_RAN_WITHOUT_COMPACTION", type: "text" }],
                    };
                }

                expect(request.providerId).toBe("codex");
                parentSessionId ??= sessionId;
                expect(sessionId).toBe(parentSessionId);
                const lastText = messageText(request.context.messages.at(-1));
                if (lastText.includes("Create the high parent checkpoint.")) {
                    return {
                        content: [{ text: "PARENT_CHECKPOINT_CONTEXT", type: "text" }],
                        contextTokens: 331_600,
                    };
                }
                if (lastText.includes("Start the inherited Fable child.")) {
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "all",
                                    message: "Review the inherited context.",
                                    model: "anthropic/fable-5",
                                    provider: "claude",
                                    reasoning_effort: "medium",
                                    task_name: "inherited_checkpoint_child",
                                },
                                id: "spawn-inherited-checkpoint-child",
                                name: "spawn_agent",
                                namespace: "collaboration_ext",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (lastText.includes("<subagent-notification>")) {
                    return { content: [{ text: "PARENT_SAW_CHILD_COMPLETE", type: "text" }] };
                }
                return { content: [{ text: "PARENT_STARTED_CHILD", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex", "claude"],
            rows: 28,
        });
        running.add(gym);

        submit(gym, "Create the high parent checkpoint.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PARENT_CHECKPOINT_CONTEXT") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the parent checkpoint turn to settle",
            30_000,
        );

        submit(gym, "Start the inherited Fable child.");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                childInferenceSeen &&
                snapshot.text.includes('"Inherited checkpoint child" completed in'),
            "the inherited Fable child to complete",
            30_000,
        );

        expect(childCompactionSeen).toBe(false);
        expect(completed.text).not.toContain(
            "Claude completed compaction without reporting token usage",
        );
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function messageText(
    message: { content: string | readonly { text?: string; type: string }[] | null } | undefined,
): string {
    if (message?.content == null) return "";
    if (typeof message.content === "string") return message.content;
    return message.content
        .filter((block): block is { text: string; type: string } => typeof block.text === "string")
        .map((block) => block.text)
        .join("");
}
