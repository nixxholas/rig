import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("subagent tool call model display", () => {
    it("shows each subagent's selected model in live call rows", async () => {
        const releaseChildren = deferred<void>();
        let parentSessionId: string | undefined;
        const gym = await createGym({
            inference: async (request) => {
                const sessionId = request.options.sessionId;
                if (sessionId?.endsWith(":title") === true) {
                    return { content: [{ text: "Subagent model display", type: "text" }] };
                }
                if (parentSessionId === undefined) {
                    parentSessionId = sessionId;
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "none",
                                    message: "Wait, then return FIRST_CHILD_DONE.",
                                    model: "openai/gym",
                                    reasoning_effort: "medium",
                                    task_name: "first_child",
                                },
                                id: "spawn-first-child",
                                name: "spawn_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                            {
                                arguments: {
                                    fork_turns: "none",
                                    message: "Wait, then return SECOND_CHILD_DONE.",
                                    model: "openai/gym",
                                    reasoning_effort: "low",
                                    task_name: "second_child",
                                },
                                id: "spawn-second-child",
                                name: "spawn_agent",
                                namespace: "collaboration",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (sessionId !== parentSessionId) {
                    await releaseChildren.promise;
                    const prompt = messageText(request.context.messages.at(-1));
                    return {
                        content: [
                            {
                                text: prompt.includes("FIRST")
                                    ? "FIRST_CHILD_DONE"
                                    : "SECOND_CHILD_DONE",
                                type: "text",
                            },
                        ],
                    };
                }
                const lastMessage = request.context.messages.at(-1);
                if (messageText(lastMessage).includes("<subagent-notification>")) {
                    return { content: [{ text: "PARENT_NOTED_CHILD", type: "text" }] };
                }
                return { content: [{ text: "PARENT_SPAWNED_CHILDREN", type: "text" }] };
            },
            rows: 28,
        });
        running.add(gym);

        gym.terminal.type("Start two children with selected models.");
        gym.terminal.press("enter");

        const spawned = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PARENT_SPAWNED_CHILDREN") &&
                snapshot.text.includes("2 agents running"),
            "both model-labelled subagent calls",
            30_000,
        );
        expect(spawned.text).toContain("First child · Gym");
        expect(spawned.text).toContain("Second child · Gym");

        releaseChildren.resolve();
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes('"First child" completed in') &&
                snapshot.text.includes('"Second child" completed in'),
            "both children to complete",
            30_000,
        );
    }, 120_000);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
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
