import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("failed subagent steers its parent", () => {
    it("interrupts a steerable parent tool and delivers the failure", async () => {
        let parentSessionId: string | undefined;
        let childSessionId: string | undefined;
        let parentObservedFailure = false;
        const gym = await createGym({
            inference(request) {
                const sessionId = request.options.sessionId;
                expect(sessionId).toBeTypeOf("string");
                const lastMessage = request.context.messages.at(-1);
                const lastText = messageText(lastMessage?.content);

                if (parentSessionId === undefined) {
                    parentSessionId = sessionId;
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "none",
                                    message:
                                        "Fail deterministically after the parent starts waiting.",
                                    model: "openai/gym",
                                    reasoning_effort: "medium",
                                    task_name: "failing_check",
                                },
                                id: "spawn-failing-check",
                                name: "spawn_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                            {
                                arguments: { cmd: "sleep 30" },
                                id: "parent-steerable-wait",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (lastText.includes("Fail deterministically after the parent starts waiting.")) {
                    childSessionId ??= sessionId;
                    expect(sessionId).toBe(childSessionId);
                    expect(sessionId).not.toBe(parentSessionId);
                    return {
                        completionDelayMs: 500,
                        content: [],
                        errorMessage: "DETERMINISTIC_CHILD_FAILURE",
                        stopReason: "error",
                    };
                }

                expect(sessionId).toBe(parentSessionId);
                expect(lastText).toContain("<subagent-notification>");
                expect(lastText).toContain("Status: error");
                expect(lastText).toContain("Result: DETERMINISTIC_CHILD_FAILURE");
                parentObservedFailure = true;
                return {
                    content: [{ text: "PARENT_ACKNOWLEDGED_CHILD_FAILURE", type: "text" }],
                };
            },
            rows: 24,
        });
        running.add(gym);

        gym.terminal.type("Delegate a failing check, then wait.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PARENT_ACKNOWLEDGED_CHILD_FAILURE") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "failed child steering the parent wait",
            10_000,
        );

        expect(parentObservedFailure).toBe(true);
        expect(childSessionId).toBeTypeOf("string");
        expect(completed.text).toContain('"Failing check" failed');
        expect(completed.text).not.toContain("sleep 30 completed");
    }, 20_000);
});

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
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
        .join("\n");
}
