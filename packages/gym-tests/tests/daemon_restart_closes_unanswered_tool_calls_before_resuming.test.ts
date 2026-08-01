import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("tool calls interrupted by a daemon crash", () => {
    it("records an interrupted result before the next inference resumes", async () => {
        let parentSessionId: string | undefined;
        let childStarted = false;
        const gym = await createGym({
            environment: { RIG_GYM_IN_PROCESS_DAEMON: "0" },
            inference(request) {
                const sessionId = request.options.sessionId;
                const lastMessage = request.context.messages.at(-1);
                const lastText = messageText(lastMessage?.content);

                if (sessionId?.endsWith(":title")) {
                    return { content: [{ text: "Interrupted tool recovery", type: "text" }] };
                }
                if (lastText.includes("Continue after the daemon crash.")) {
                    const callIndex = request.context.messages.findIndex(
                        (message) =>
                            message.role === "assistant" &&
                            message.content.some(
                                (content) =>
                                    content.type === "toolCall" &&
                                    content.name === "wait_agent" &&
                                    content.providerToolCallId === "wait-across-daemon-crash",
                            ),
                    );
                    const call = request.context.messages[callIndex];
                    const toolCall =
                        call?.role === "assistant"
                            ? call.content.find(
                                  (content) =>
                                      content.type === "toolCall" && content.name === "wait_agent",
                              )
                            : undefined;
                    const result = request.context.messages[callIndex + 1];
                    if (
                        toolCall?.type !== "toolCall" ||
                        result?.role !== "toolResult" ||
                        !result.isError ||
                        result.providerToolCallId !== "wait-across-daemon-crash" ||
                        result.toolCallId !== toolCall.id ||
                        result.toolName !== "wait_agent"
                    ) {
                        return {
                            content: [{ text: "INTERRUPTED_TOOL_CALL_STILL_OPEN", type: "text" }],
                        };
                    }
                    return {
                        content: [{ text: "INTERRUPTED_TOOL_CALL_RECOVERED", type: "text" }],
                    };
                }
                if (lastText.includes("Stay active until the daemon crashes.")) {
                    childStarted = true;
                    return {
                        content: [{ text: "STALE_CHILD_AFTER_CRASH", type: "text" }],
                        delayMs: 60_000,
                    };
                }
                if (parentSessionId === undefined) {
                    parentSessionId = sessionId;
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "none",
                                    message: "Stay active until the daemon crashes.",
                                    model: "openai/gym",
                                    reasoning_effort: "medium",
                                    task_name: "crash_wait_child",
                                },
                                id: "spawn-crash-wait-child",
                                name: "spawn_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (lastMessage?.role === "toolResult" && lastMessage.toolName === "spawn_agent") {
                    return {
                        content: [
                            {
                                arguments: { timeout_ms: 60_000 },
                                id: "wait-across-daemon-crash",
                                name: "wait_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                throw new Error(`Unexpected inference request: ${lastText}`);
            },
            rows: 28,
        });
        running.add(gym);

        submit(gym, "Start delegated work and wait for it.");
        await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("Wait for delegated work") && childStarted,
            "the parent to persist its active wait tool call",
            30_000,
        );

        await crashDaemon(gym);
        submit(gym, "/reload");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Resumed") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the TUI to reload the interrupted session",
            30_000,
        );

        submit(gym, "Continue after the daemon crash.");
        const recovered = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("INTERRUPTED_TOOL_CALL_RECOVERED") ||
                snapshot.text.includes("INTERRUPTED_TOOL_CALL_STILL_OPEN"),
            "the resumed inference to inspect the interrupted tool call",
            30_000,
        );
        expect(recovered.text).toContain("INTERRUPTED_TOOL_CALL_RECOVERED");
        expect(recovered.text).not.toContain("Cannot compact while tool call");
        expect(recovered.text).not.toContain("STALE_CHILD_AFTER_CRASH");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
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

async function crashDaemon(gym: Gym): Promise<void> {
    await gym.runInContainer("node", [
        "--input-type=module",
        "--eval",
        `
import { readFile } from "node:fs/promises";
const registry = JSON.parse(
    await readFile(process.env.RIG_SERVER_DIRECTORY + "/server.json", "utf8"),
);
process.kill(registry.pid, "SIGKILL");
for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
        process.kill(registry.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
        break;
    }
}
console.log(registry.pid);
`,
    ]);
}
