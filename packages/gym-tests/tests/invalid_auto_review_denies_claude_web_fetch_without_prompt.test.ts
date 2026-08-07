import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("web_fetch after an invalid Auto review", () => {
    it("fails closed without asking the user for permission", async () => {
        const gym = await createGym({
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            inference(request, callIndex) {
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    )
                ) {
                    expect(callIndex).toBe(1);
                    return {
                        content: [{ text: "not a permission decision", type: "text" }],
                    };
                }

                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    prompt: "Summarize this page.",
                                    url: "https://example.com",
                                },
                                id: "claude-web-fetch-invalid-review",
                                name: "web_fetch",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(2);
                const result = request.context.messages.at(-1);
                expect(result).toMatchObject({
                    isError: true,
                    role: "toolResult",
                    toolName: "web_fetch",
                });
                expect(messageText(result)).toContain(
                    "The automatic permission review returned an unreadable decision.",
                );
                expect(messageText(result)).toContain("https://example.com");
                return {
                    content: [{ text: "INVALID_AUTO_REVIEW_DENIED", type: "text" }],
                };
            },
            modelId: "anthropic/opus-4-8",
            permissionMode: "auto",
            providerId: "claude",
            providerOverrides: ["claude"],
        });
        running.add(gym);

        submit(gym, "Fetch example.com only if Auto permits it.");
        const denied = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes(
                    "Refused: The automatic permission review returned an unreadable decision.",
                ) &&
                snapshot.text.includes("INVALID_AUTO_REVIEW_DENIED") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the refused web_fetch action and recovered composer",
            30_000,
        );
        expect(denied.text.replace(/\s+/gu, " ")).toContain(
            "Risk: Medium. User authorization: Low.",
        );
        expect(denied.text).not.toContain("Allow once");
        expect(denied.text).not.toContain("Waiting for approval");
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
