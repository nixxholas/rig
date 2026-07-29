import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("steering at a provider tool-batch boundary", () => {
    it("closes the whole nearest batch and puts steering in the exact next inference", async () => {
        const releaseInference = deferred<void>();
        const steering = "CHANGE_DIRECTION_AFTER_THIS_BATCH";
        const gym = await createGym({
            async inference(request, callIndex) {
                if (callIndex === 0) {
                    await releaseInference.promise;
                    return {
                        content: [
                            {
                                arguments: { cmd: "printf 'FIRST_BATCH_RESULT\\n'" },
                                id: "batch-call-one",
                                name: "exec_command",
                                type: "toolCall",
                            },
                            {
                                arguments: { cmd: "printf 'SECOND_BATCH_RESULT\\n'" },
                                id: "batch-call-two",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(1);
                const messages = request.context.messages;
                const steeringIndex = messages.findIndex(
                    (message) =>
                        message.role === "user" && JSON.stringify(message.content).includes(steering),
                );
                const resultIndexes = messages.flatMap((message, index) =>
                    message.role === "toolResult" ? [index] : [],
                );
                expect(
                    resultIndexes,
                    JSON.stringify(
                        messages.map((message) => ({
                            role: message.role,
                            ...("toolCallId" in message ? { toolCallId: message.toolCallId } : {}),
                        })),
                    ),
                ).toHaveLength(2);
                expect(Math.max(...resultIndexes)).toBe(steeringIndex - 1);
                return { content: [{ text: "STEERING_BATCH_BOUNDARY_CONFIRMED", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Run the next provider batch.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        submit(gym, steering);
        await waitForPendingSteering(gym, steering);
        releaseInference.resolve();

        const screen = await gym.terminal.waitForText(
            "STEERING_BATCH_BOUNDARY_CONFIRMED",
            30_000,
        );
        expect(screen.text).not.toContain("Messages to be submitted after next tool call");
    }, 120_000);

    it("compacts an oversized closed batch before the steered inference", async () => {
        const releaseInference = deferred<void>();
        const steering = "STEER_AFTER_REQUIRED_COMPACTION";
        let sawCompaction = false;
        const gym = await createGym({
            contextWindow: 500,
            async inference(request, callIndex) {
                if (request.options.intent === "compaction") {
                    sawCompaction = true;
                    expect(
                        request.context.messages.filter(
                            (message) => message.role === "toolResult",
                        ),
                    ).toHaveLength(2);
                    return {
                        content: [{ text: "Provider compacted the closed batch.", type: "text" }],
                    };
                }
                if (callIndex === 0) {
                    await releaseInference.promise;
                    return {
                        content: [
                            {
                                arguments: { cmd: "printf 'FIRST_COMPACTED_RESULT\\n'" },
                                id: "compacted-call-one",
                                name: "exec_command",
                                type: "toolCall",
                            },
                            {
                                arguments: { cmd: "printf 'SECOND_COMPACTED_RESULT\\n'" },
                                id: "compacted-call-two",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                        usage: usage(400, 50),
                    };
                }

                expect(sawCompaction).toBe(true);
                const serialized = JSON.stringify(request.context.messages);
                expect(serialized).toContain("Provider compacted the closed batch.");
                expect(serialized).toContain(steering);
                return {
                    content: [{ text: "COMPACTION_THEN_STEERING_CONFIRMED", type: "text" }],
                };
            },
        });
        running.add(gym);

        submit(gym, "Run an oversized provider batch.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        submit(gym, steering);
        await waitForPendingSteering(gym, steering);
        releaseInference.resolve();

        const screen = await gym.terminal.waitForText(
            "COMPACTION_THEN_STEERING_CONFIRMED",
            30_000,
        );
        expect(screen.text).toContain("Context compacted");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function waitForPendingSteering(gym: Gym, steering: string): Promise<void> {
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.text.includes("Messages to be submitted after next tool call") &&
            snapshot.text.includes(steering),
        `pending steering ${steering}`,
        30_000,
    );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value as T),
    };
}

function usage(input: number, output: number) {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input,
        output,
        totalTokens: input + output,
    };
}