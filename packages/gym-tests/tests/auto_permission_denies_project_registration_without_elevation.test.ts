import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("project registration Auto permission", () => {
    it("denies add_project without requesting temporary Full access", async () => {
        const gym = await createGym({
            async inference(request, callIndex) {
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    )
                ) {
                    const reviewTranscript = messageText(request.context.messages.at(-1));
                    expect(reviewTranscript).toContain(
                        "inspect and register the local Git repository",
                    );
                    expect(reviewTranscript).toContain("/workspace");
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "deny",
                                    rationale: "Project registration was not authorized.",
                                    risk_level: "medium",
                                    user_authorization: "low",
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
                                arguments: { path: "/workspace" },
                                id: "denied-project-registration",
                                name: "add_project",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(callIndex).toBeGreaterThan(0);
                expect(request.context.messages.at(-1)).toMatchObject({
                    isError: true,
                    role: "toolResult",
                    toolName: "add_project",
                });
                return {
                    content: [{ text: "PROJECT_REGISTRATION_DENIED", type: "text" }],
                };
            },
            homeFiles: { "happy/config/happy.toml": "[features]\ncross_workspace = true\n" },
            permissionMode: "auto",
        });
        running.add(gym);

        gym.terminal.type("Add /workspace as a project only if Auto permits it.");
        gym.terminal.press("enter");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PROJECT_REGISTRATION_DENIED") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "denied project registration and completed turn",
            30_000,
        );

        expect(completed.text).toContain("Automatic permission review refused");
        expect(completed.text).toContain("Project registration was not authorized.");
        expect(completed.text).not.toContain("temporary Full access");
        expect(
            gym.inference.requests.filter((request) =>
                request.context.systemPrompt?.includes("judging one planned coding-agent action"),
            ),
        ).toHaveLength(1);
    }, 120_000);
});

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string; type: "text" } =>
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
}
