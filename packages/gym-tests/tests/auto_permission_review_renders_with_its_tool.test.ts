import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("successful Auto permission reviews", () => {
    it("shows temporary Full access on the command without exposing reviewer rationale", async () => {
        const reviewStarted = deferred<void>();
        const releaseReview = deferred<void>();
        const gym = await createGym({
            mode: "docker",
            cols: 132,
            async inference(request, callIndex) {
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    )
                ) {
                    reviewStarted.resolve();
                    await releaseReview.promise;
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    rationale:
                                        "The user explicitly authorized this harmless home-directory check.",
                                    risk_level: "low",
                                    user_authorization: "high",
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
                                arguments: {
                                    cmd: "printf 'INLINE_APPROVAL_MARKER\\n' > /home/rig/inline-approval.txt",
                                    justification:
                                        "Create the home-directory marker the user requested.",
                                    sandbox_permissions: "require_escalated",
                                },
                                id: "inline-auto-approval",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                return {
                    content: [{ text: "INLINE_AUTO_APPROVAL_COMPLETE", type: "text" }],
                };
            },
            permissionMode: "auto",
            rows: 32,
        });
        running.add(gym);

        try {
            submit(gym, "Create the harmless marker in my home directory.");
            await reviewStarted.promise;
            const reviewing = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("Reviewing exec_command") &&
                    snapshot.text.includes("INLINE_APPROVAL_MARKER"),
                "tool shown during automatic permission review",
                30_000,
            );
            expect(reviewing.rows.some((row) => row.includes("Reviewing exec_command"))).toBe(true);

            releaseReview.resolve();
            const completed = await gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("INLINE_AUTO_APPROVAL_COMPLETE") &&
                    snapshot.text.includes("Ask Rig to do anything"),
                "completed automatically approved tool",
                30_000,
            );

            const toolRow = completed.rows.findIndex((row) =>
                row.includes("INLINE_APPROVAL_MARKER"),
            );
            expect(toolRow).toBeGreaterThanOrEqual(0);
            expect(completed.text).toContain("Approved automatically: temporary Full access.");
            expect(completed.text).not.toContain("Risk: Low");
            expect(completed.text).not.toContain("User authorization: High");
            expect(completed.text).not.toContain(
                "The user explicitly authorized this harmless home-directory check.",
            );
            expect(completed.rows.some((row) => row.includes("Auto permission"))).toBe(false);
        } finally {
            releaseReview.resolve();
        }
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolve: (value?: T) => void = () => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve as (value?: T) => void;
    });
    return { promise, resolve };
}
